import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

const staleMs = 60_000
export const heartbeatMs = 5_000
export interface Owner {
	pid: number
	token: string
	timestamp: number
}
export function owner(): Owner {
	return { pid: process.pid, token: randomUUID(), timestamp: Date.now() }
}
export function alive(record: Owner): boolean {
	if (Date.now() - record.timestamp > staleMs) return false
	try {
		process.kill(record.pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
	}
}

/** The recovery gate prevents a stale-lock contender from deleting a successor's lock. */
export async function storageLock(directory: string): Promise<() => Promise<void>> {
	await fs.mkdir(directory, { recursive: true })
	const lock = path.join(directory, "mutation.lock")
	const recovery = `${lock}.recovery`
	const mine = owner()
	const deadline = Date.now() + 15_000
	while (true) {
		try {
			await fs.access(recovery)
		} catch {
			try {
				await fs.mkdir(lock)
				await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify(mine))
				// Recovery may have begun between the first check and mkdir.
				try {
					await fs.access(recovery)
					await fs.rm(lock, { recursive: true, force: true })
				} catch {
					const timer = setInterval(() => {
						void fs
							.readFile(path.join(lock, "owner.json"), "utf8")
							.then(async (raw) => {
								if ((JSON.parse(raw) as Owner).token === mine.token) await fs.utimes(lock, new Date(), new Date())
							})
							.catch(() => {})
					}, heartbeatMs)
					timer.unref()
					return async () => {
						clearInterval(timer)
						const record = await fs
							.readFile(path.join(lock, "owner.json"), "utf8")
							.then((raw) => JSON.parse(raw) as Owner)
							.catch(() => undefined)
						if (record?.token === mine.token) await fs.rm(lock, { recursive: true, force: true })
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			}
		}
		try {
			await fs.mkdir(recovery)
			try {
				const stat = await fs.stat(lock).catch(() => undefined)
				const record = await fs
					.readFile(path.join(lock, "owner.json"), "utf8")
					.then((s) => JSON.parse(s) as Owner)
					.catch(() => undefined)
				if (stat && ((record && !alive({ ...record, timestamp: stat.mtimeMs })) || Date.now() - stat.mtimeMs > staleMs)) {
					await fs.rm(lock, { recursive: true, force: true })
				}
			} finally {
				await fs.rmdir(recovery)
			}
		} catch (error) {
			if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
		}
		// Recover a crashed recovery owner as well; the gate only encloses local file IO.
		const gate = await fs.stat(recovery).catch(() => undefined)
		if (gate && Date.now() - gate.mtimeMs > staleMs) await fs.rmdir(recovery).catch(() => {})
		if (Date.now() > deadline) throw new Error("Worktree storage is busy in another window. Try again shortly.")
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
}
