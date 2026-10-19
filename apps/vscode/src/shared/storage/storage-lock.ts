import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const heartbeatMs = 5_000
export interface Owner {
	pid: number
	token: string
	timestamp: number
	host?: string
	processStart?: string
}
function processStart(pid: number): string | undefined {
	try {
		const command = process.platform === "win32" ? "powershell.exe" : "ps"
		const args =
			process.platform === "win32"
				? [
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
					]
				: ["-o", "lstart=", "-p", String(pid)]
		const start = execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
		}).trim()
		return start ? `${process.platform === "win32" ? "ticks" : "ps-utc"}:${start}` : undefined
	} catch {
		return undefined
	}
}
const started = processStart(process.pid)
export function owner(): Owner {
	return { pid: process.pid, token: randomUUID(), timestamp: Date.now(), host: os.hostname(), processStart: started }
}
export function alive(record: Owner): boolean {
	if (record.host && record.host !== os.hostname()) return true
	if (!Number.isInteger(record.pid) || record.pid <= 0) return true
	try {
		process.kill(record.pid, 0)
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
	}
	// Age is never proof of death. A paused host still owns its lock.
	// Older records lack a timezone/locale convention. Treat an existing pid
	// conservatively rather than confusing a format change with pid reuse.
	if (!record.processStart || !/^(ps-utc|ticks):/.test(record.processStart)) return true
	const current = processStart(record.pid)
	return !current || current === record.processStart
}
export interface StorageLock {
	(): void
	assertOwned(): void
}
export interface StorageLockOptions {
	timeoutMs?: number
	retryMs?: number
}
export class StorageLockTimeoutError extends Error {
	constructor() {
		super("Storage is busy in another window. Try again shortly.")
	}
}
const code = (error: unknown) => (error as NodeJS.ErrnoException).code
function readOwner(file: string, symlink = false): Owner | undefined {
	try {
		return JSON.parse(symlink ? fs.readlinkSync(file) : fs.readFileSync(file, "utf8")) as Owner
	} catch {
		return undefined
	}
}
function removeEmpty(lock: string): void {
	try {
		fs.rmdirSync(lock)
	} catch (error) {
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error
	}
}

/** The worktree protocol: publish a complete directory, fence removal by unique owner filename. */
function tryDirectoryLock(lock: string): StorageLock | undefined {
	const mine = owner()
	const filename = `owner-${mine.token}.json`
	const candidate = `${lock}.${mine.token}.pending`
	fs.mkdirSync(candidate)
	let published = false
	try {
		fs.writeFileSync(path.join(candidate, filename), JSON.stringify(mine), { mode: 0o600 })
		try {
			fs.renameSync(candidate, lock)
			published = true
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) throw error
			return undefined
		}
		return Object.assign(
			() => {
				try {
					fs.unlinkSync(path.join(lock, filename))
				} catch (error) {
					if (code(error) !== "ENOENT") throw error
				}
				removeEmpty(lock)
			},
			{
				assertOwned: () => {
					if (readOwner(path.join(lock, filename))?.token !== mine.token)
						throw new Error("Storage lock ownership was lost")
				},
			},
		)
	} finally {
		if (!published) fs.rmSync(candidate, { recursive: true, force: true })
	}
}
function recoverDirectory(lock: string, legacy = false): void {
	let files: string[]
	try {
		files = fs.readdirSync(lock)
	} catch (error) {
		if (code(error) === "ENOENT") return
		throw error
	}
	for (const file of files) {
		if (!/^owner-[\w-]+\.json$/.test(file) && !(legacy && file === "owner.json")) continue
		const record = readOwner(path.join(lock, file))
		if (record && (file === `owner-${record.token}.json` || (legacy && file === "owner.json")) && !alive(record)) {
			try {
				fs.unlinkSync(path.join(lock, file))
			} catch (error) {
				if (code(error) !== "ENOENT") throw error
			}
		}
	}
	// Another recoverer can remove the abandoned directory, but cannot remove
	// a successor's nonempty directory or its differently named owner file.
	removeEmpty(lock)
}

/**
 * POSIX publishes the entire owner record in one symlink, and releases with
 * one unlink. Windows uses directories so it needs no symlink privileges.
 */
export function tryStorageLock(lock: string): StorageLock | undefined {
	if (process.platform === "win32") return tryDirectoryLock(lock)
	const mine = owner()
	try {
		fs.symlinkSync(JSON.stringify(mine), lock)
	} catch (error) {
		if (code(error) === "EEXIST") return undefined
		throw error
	}
	return Object.assign(
		() => {
			if (readOwner(lock, true)?.token === mine.token) fs.unlinkSync(lock)
		},
		{
			assertOwned: () => {
				if (readOwner(lock, true)?.token !== mine.token) throw new Error("Storage lock ownership was lost")
			},
		},
	)
}
function recover(lock: string): void {
	// Only one recoverer may examine/unlink the shared symlink. Without this
	// gate, a delayed waiter could unlink a fresh owner's replacement link.
	// The gate itself uses the fenced directory protocol, including recovery.
	const gate = `${lock}.recovery`
	const release = tryDirectoryLock(gate)
	if (!release) {
		recoverDirectory(gate)
		return
	}
	try {
		const record = readOwner(lock, true)
		if (record) {
			// A dead owner cannot release its link; only this gate holder can
			// remove it. Re-read after acquiring the gate, never before.
			if (!alive(record)) fs.unlinkSync(lock)
		} else {
			try {
				recoverDirectory(lock, true)
			} catch (error) {
				// Malformed/unknown records are preserved, never guessed stale.
				if (code(error) !== "ENOTDIR") throw error
			}
		}
	} finally {
		release()
	}
}
export async function acquireStorageLock(lock: string, options: StorageLockOptions = {}): Promise<StorageLock> {
	const deadline = Date.now() + (options.timeoutMs ?? 15_000)
	for (;;) {
		const release = tryStorageLock(lock)
		if (release) return release
		recover(lock)
		if (Date.now() >= deadline) throw new StorageLockTimeoutError()
		await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 25))
	}
}
export async function storageLock(directory: string): Promise<StorageLock> {
	fs.mkdirSync(directory, { recursive: true })
	return acquireStorageLock(path.join(directory, "mutation.lock"))
}
