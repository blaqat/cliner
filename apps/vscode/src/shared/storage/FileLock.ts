import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import { Logger } from "../services/Logger"

export interface FileLockOptions {
	/** A lock older than this is reclaimed even if its owner looks alive (pid reuse, hung process). */
	staleMs?: number
	/** Give up acquiring after this long. */
	timeoutMs?: number
	retryMs?: number
}

interface LockRecord {
	pid: number
	token: string
	at: number
}

const DEFAULTS = { staleMs: 30_000, timeoutMs: 10_000, retryMs: 25 }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function readLock(lockPath: string): LockRecord | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8"))
		return typeof parsed?.pid === "number" && typeof parsed?.token === "string" && typeof parsed?.at === "number"
			? parsed
			: undefined
	} catch {
		return undefined
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: it exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

function isStale(lockPath: string, record: LockRecord | undefined, staleMs: number): boolean {
	if (record) return !processAlive(record.pid) || Date.now() - record.at > staleMs
	// Unreadable record: only reclaim it once it is clearly abandoned.
	try {
		return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs
	} catch {
		return false
	}
}

/**
 * Remove an abandoned lock. The rename is what makes this safe against two
 * waiters reclaiming at once: only one rename succeeds, and if what it moved
 * turns out to be a fresh lock (the other waiter already replaced the stale
 * one) it is put back rather than deleted.
 */
function reclaim(lockPath: string, examined: LockRecord | undefined): void {
	const moved = `${lockPath}.stale.${randomUUID()}`
	try {
		fs.renameSync(lockPath, moved)
	} catch {
		return
	}
	const actual = readLock(moved)
	if (actual && examined && actual.token !== examined.token) {
		try {
			fs.linkSync(moved, lockPath)
		} catch {
			// Someone else holds a lock again; nothing to restore.
		}
	}
	try {
		fs.unlinkSync(moved)
	} catch {}
}

/**
 * Take an interprocess lock: an exclusively created file naming the owner's
 * pid. The record is written to a temp file and hard-linked into place, so the
 * lock never exists half-written. Locks whose owner has exited (or that are
 * older than `staleMs`) are reclaimed. Resolves to a release function, or
 * undefined if the lock could not be taken within `timeoutMs`.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<(() => void) | undefined> {
	const { staleMs, timeoutMs, retryMs } = { ...DEFAULTS, ...options }
	const record: LockRecord = { pid: process.pid, token: randomUUID(), at: Date.now() }
	const pending = `${lockPath}.${record.token}.tmp`
	const deadline = Date.now() + timeoutMs
	try {
		fs.writeFileSync(pending, JSON.stringify(record), { flag: "wx" })
	} catch (error) {
		Logger.error(`[FileLock] cannot prepare ${lockPath}:`, error)
		return undefined
	}
	try {
		for (;;) {
			try {
				try {
					fs.linkSync(pending, lockPath)
				} catch (error) {
					// Filesystems without hard links: exclusive create is still atomic.
					const code = (error as NodeJS.ErrnoException).code
					if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw error
					fs.writeFileSync(lockPath, JSON.stringify(record), { flag: "wx" })
				}
				return () => {
					// Only remove our own lock; it may have been reclaimed as stale.
					if (readLock(lockPath)?.token === record.token) {
						try {
							fs.unlinkSync(lockPath)
						} catch {}
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					Logger.error(`[FileLock] cannot take ${lockPath}:`, error)
					return undefined
				}
			}
			const holder = readLock(lockPath)
			if (isStale(lockPath, holder, staleMs)) {
				reclaim(lockPath, holder)
				continue
			}
			if (Date.now() >= deadline) return undefined
			await sleep(retryMs)
		}
	} finally {
		try {
			fs.unlinkSync(pending)
		} catch {}
	}
}
