import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
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
		return (
			execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined
		)
	} catch {
		return undefined
	}
}
const started = processStart(process.pid)
export function owner(): Owner {
	return { pid: process.pid, token: randomUUID(), timestamp: Date.now(), host: os.hostname(), processStart: started }
}
export function alive(record: Owner): boolean {
	// Age is never proof of death: an extension host can be paused indefinitely.
	if (record.host && record.host !== os.hostname()) return true
	if (!Number.isInteger(record.pid) || record.pid <= 0) return true
	try {
		process.kill(record.pid, 0)
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
	}
	const current = record.processStart && processStart(record.pid)
	return !current || current === record.processStart
}

export interface StorageLock {
	(): Promise<void>
	assertOwned(): Promise<void>
}

/** Publish a complete owner directory atomically; remove only that owner's unique file. */
export async function storageLock(directory: string): Promise<StorageLock> {
	await fs.mkdir(directory, { recursive: true })
	const lock = path.join(directory, "mutation.lock")
	const mine = owner()
	const filename = `owner-${mine.token}.json`
	const candidate = path.join(directory, `.lock-${mine.token}`)
	await fs.mkdir(candidate)
	await fs.writeFile(path.join(candidate, filename), JSON.stringify(mine), { mode: 0o600 })
	const deadline = Date.now() + 15_000
	try {
		while (true) {
			try {
				await fs.rename(candidate, lock)
				const assertOwned = async () => {
					const record = await fs
						.readFile(path.join(lock, filename), "utf8")
						.then((raw) => JSON.parse(raw) as Owner)
						.catch(() => undefined)
					if (record?.token !== mine.token) throw new Error("Worktree storage lock ownership was lost")
				}
				const release = async () => {
					await fs.unlink(path.join(lock, filename)).catch((error) => {
						if (error.code !== "ENOENT") throw error
					})
					await fs.rmdir(lock).catch((error) => {
						if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error
					})
				}
				return Object.assign(release, { assertOwned })
			} catch (error) {
				if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
			}
			for (const file of await fs.readdir(lock).catch(() => [] as string[])) {
				if (file !== "owner.json" && !/^owner-[\w-]+\.json$/.test(file)) continue
				const record = await fs
					.readFile(path.join(lock, file), "utf8")
					.then((raw) => JSON.parse(raw) as Owner)
					.catch(() => undefined)
				if (record && !alive(record)) await fs.unlink(path.join(lock, file)).catch(() => {})
			}
			// A competing recovery cannot delete a successor's nonempty directory.
			await fs.rmdir(lock).catch(() => {})
			if (Date.now() > deadline) throw new Error("Worktree storage is busy in another window. Try again shortly.")
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
	} finally {
		await fs.rm(candidate, { recursive: true, force: true })
	}
}
