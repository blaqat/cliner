import { spawn } from "node:child_process"
import { createWriteStream, promises as fs } from "node:fs"
import path from "node:path"

export const SCRIPT_OUTPUT_TAIL_LINES = 100
const MAX_TAIL_LINE_LENGTH = 2000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface ScriptRunOptions {
	command: string
	cwd: string
	/** Full environment for the process (terminal env helper output). */
	env: Record<string, string>
	logPath: string
	signal?: AbortSignal
	timeoutMs?: number
	tailLines?: number
}

export interface ScriptRunResult {
	exitCode: number | null
	/** Termination signal when the process was killed. */
	signal?: string
	timedOut: boolean
	aborted: boolean
	/** Last lines of combined stdout/stderr, ANSI stripped. */
	tail: string
	totalLines: number
	logPath: string
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
const ANSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

function killTree(pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): void {
	if (!pid) return
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => {})
		} else {
			process.kill(-pid, signal)
		}
	} catch {
		// Already gone.
	}
}

/**
 * Runs a rendered script command through the shell and returns its exit code
 * and output tail. The whole output is written to `logPath` so the agent can
 * read past the tail.
 */
export async function runScriptCommand(options: ScriptRunOptions): Promise<ScriptRunResult> {
	const tailLimit = options.tailLines ?? SCRIPT_OUTPUT_TAIL_LINES
	await fs.mkdir(path.dirname(options.logPath), { recursive: true })
	const log = createWriteStream(options.logPath, { flags: "w" })
	await new Promise<void>((resolve, reject) => {
		log.once("open", () => resolve())
		log.once("error", reject)
	})

	const tail: string[] = []
	let totalLines = 0
	const pushLine = (line: string) => {
		totalLines++
		tail.push(line.length > MAX_TAIL_LINE_LENGTH ? `${line.slice(0, MAX_TAIL_LINE_LENGTH)}…` : line)
		if (tail.length > tailLimit) tail.shift()
	}
	// Each stream keeps its own partial line, so a half-written stdout line never merges with stderr.
	const pendingByStream = { stdout: "", stderr: "" }
	const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
		if (!log.destroyed) log.write(chunk)
		const lines = (pendingByStream[stream] + chunk.toString("utf8")).split(/\r?\n/)
		pendingByStream[stream] = lines.pop() ?? ""
		for (const line of lines) pushLine(line)
	}

	return await new Promise<ScriptRunResult>((resolve, reject) => {
		let timedOut = false
		let aborted = false
		let settled = false
		let stopping = false
		let logError: Error | undefined
		let forceTimer: ReturnType<typeof setTimeout> | undefined
		const child = spawn(options.command, {
			shell: true,
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group on POSIX so a timeout or cancel stops the whole tree.
			detached: process.platform !== "win32",
			windowsHide: true,
		})
		const finish = (exitCode: number | null, signal?: string, spawnError?: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			clearTimeout(forceTimer)
			child.stdout?.destroy()
			child.stderr?.destroy()
			options.signal?.removeEventListener("abort", onAbort)
			for (const rest of [pendingByStream.stdout, pendingByStream.stderr]) if (rest) pushLine(rest)
			if (spawnError) pushLine(`Failed to start: ${spawnError.message}`)
			if (logError) {
				log.destroy()
				reject(new Error(`Script log failed: ${logError.message}`))
				return
			}
			log.end(() => {
				resolve({
					exitCode,
					...(signal ? { signal } : {}),
					timedOut,
					aborted,
					tail: tail.join("\n").replace(ANSI_REGEX, ""),
					totalLines,
					logPath: options.logPath,
				})
			})
		}
		const stop = () => {
			if (settled || stopping) return
			stopping = true
			killTree(child.pid, "SIGTERM")
			forceTimer = setTimeout(() => {
				killTree(child.pid, "SIGKILL")
				// A descendant may keep inherited pipes open even after the shell exits.
				finish(null, "SIGKILL")
			}, 3000)
		}
		const timer = setTimeout(() => {
			timedOut = true
			stop()
		}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
		const onAbort = () => {
			aborted = true
			stop()
		}
		options.signal?.addEventListener("abort", onAbort, { once: true })
		if (options.signal?.aborted) onAbort()
		child.stdout?.on("data", onData("stdout"))
		child.stderr?.on("data", onData("stderr"))
		child.on("error", (error) => finish(null, undefined, error))
		child.on("close", (code, signal) => {
			if (!stopping) finish(code, signal ?? undefined)
		})
		log.on("error", (error) => {
			logError = error
			if (settled) reject(new Error(`Script log failed: ${error.message}`))
			else stop()
		})
		log.write(`$ ${options.command}\n# cwd: ${options.cwd}\n\n`)
	})
}
