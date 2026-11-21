import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import type { ThreadWorktreeSettings } from "@shared/thread-worktrees"
import { z } from "zod"
import { exists } from "./repositories"

const execFileAsync = promisify(execFile)
const absolutePath = z.string().refine(path.isAbsolute)
const workspaceSchema = z.object({
	root: absolutePath,
	configFile: absolutePath,
	isolatesRoot: absolutePath,
	modules: z
		.array(
			z.object({
				name: z.string().min(1),
				relativePath: z.string().min(1),
				absolutePath,
				isolateFolder: z.string().min(1),
			}),
		)
		.min(1),
})
const errorSchema = z.object({
	error: z.object({ code: z.string(), message: z.string(), configFile: absolutePath.optional() }),
})

export type MmWorkspace = z.infer<typeof workspaceSchema>

export function mmError(settings: ThreadWorktreeSettings, message: string): Error {
	return new Error(`${message} mm.js path: ${settings.mmPath || "(not set)"}`)
}

function parseJson(stdout: string): unknown {
	try {
		return JSON.parse(stdout)
	} catch {
		return undefined
	}
}

export async function readMmWorkspace(workspace: string, settings: ThreadWorktreeSettings): Promise<MmWorkspace | undefined> {
	const { mmPath, nodePath } = settings
	if (!mmPath) throw mmError(settings, "Set the path to mm.js in Worktrees settings.")
	if (!(await exists(path.resolve(workspace, mmPath))))
		throw mmError(settings, "Couldn't find mm.js. Check its path in Worktrees settings.")
	if (!nodePath) throw mmError(settings, "Set the path to Node in Worktrees settings. Node path: (not set).")
	const update = "This mm doesn't list its modules yet. Update mm.js."
	let stdout: string
	try {
		stdout = (await execFileAsync(nodePath, [mmPath, "modules", "--json"], { cwd: workspace, timeout: 10000 })).stdout
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
		const response = errorSchema.safeParse(parseJson(failure.stdout ?? ""))
		if (response.success) {
			const { code, message, configFile } = response.data.error
			if (code === "NO_CONFIG") return undefined
			const file = configFile ? ` Config: ${configFile}` : ""
			throw mmError(settings, `Couldn't read mm configuration. ${message}.${file}`)
		}
		const stderr = failure.stderr?.trim() ?? ""
		// Older mm prints a text error when its config can't be loaded, before reaching the modules command.
		if (/^mm: /i.test(stderr) || /(?:unknown|unrecognized) (?:command|option)/i.test(stderr || failure.stdout || ""))
			throw mmError(settings, update)
		if (failure.code === "ENOENT" || failure.code === "EACCES") {
			throw mmError(settings, `Couldn't run Node. Check its path in Worktrees settings. Node path: ${nodePath}.`)
		}
		const detail = failure.killed ? "The command timed out." : stderr.split("\n")[0]
		throw mmError(settings, `Couldn't list mm modules.${detail ? ` ${detail}` : ""}`)
	}
	const json = parseJson(stdout)
	if (json === undefined) throw mmError(settings, update)
	const result = workspaceSchema.safeParse(json)
	if (!result.success) throw mmError(settings, "mm returned an invalid module list. Check your mm.js version.")
	return result.data
}
