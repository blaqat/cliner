import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Logger } from "../services/Logger"
import { ClineSyncStorage } from "./ClineStorage"
import { acquireStorageLock, type StorageLock, type StorageLockOptions, tryStorageLock } from "./storage-lock"

const transactions = new AsyncLocalStorage<ReadonlyMap<string, StorageLock>>()

export interface ClineFileStorageOptions {
	/**
	 * File permissions mode (e.g., 0o600 for owner read/write only).
	 * If not set, uses the system default.
	 */
	fileMode?: number
}

/**
 * Synchronous file-backed JSON storage.
 * Stores any JSON-serializable values with sync read and write.
 * Used for VSCode Memento compatibility and CLI environments.
 */
export class ClineFileStorage<T = any> extends ClineSyncStorage<T> {
	protected name: string
	private data: Record<string, T>
	private readonly fsPath: string
	private readonly fileMode?: number

	constructor(filePath: string, name = "ClineFileStorage", options?: ClineFileStorageOptions) {
		super()
		this.fsPath = filePath
		this.name = name
		this.fileMode = options?.fileMode
		this.data = this.readFromDiskStrict() ?? {}
	}

	protected _get(key: string): T | undefined {
		return this.data[key]
	}

	protected _set(key: string, value: T | undefined): void {
		// Use setBatch for consistency - all writes go through one path
		void this.setBatch({ [key]: value }).catch((error) => Logger.error(`[${this.name}] write failed:`, error))
	}

	protected _delete(key: string): void {
		void this.setBatch({ [key]: undefined }).catch((error) => Logger.error(`[${this.name}] delete failed:`, error))
	}

	/**
	 * Set multiple keys in a single write operation.
	 * More efficient than calling set() for each key individually,
	 * since it only writes to disk once.
	 */
	public setBatch(entries: Record<string, T | undefined>): Promise<void> {
		return this.withLock(() => {
			let corrupt = false
			this.data =
				this.readFromDiskStrict(() => {
					corrupt = true
				}) ?? this.data
			const changedKeys: string[] = []
			for (const [key, value] of Object.entries(entries)) {
				if (value === undefined) {
					if (key in this.data) {
						delete this.data[key]
						changedKeys.push(key)
					}
				} else {
					this.data[key] = value
					changedKeys.push(key)
				}
			}
			if (changedKeys.length > 0) {
				if (corrupt) fs.renameSync(this.fsPath, `${this.fsPath}.corrupt-${Date.now()}-${randomUUID()}`)
				this.writeToDisk()
				for (const key of changedKeys) this.fireChange(key)
			}
		})
	}

	/** Hold the same lock used by every writer, including across migration awaits. */
	public withLock<R>(operation: () => R | Promise<R>, options?: StorageLockOptions): Promise<R> {
		const lockPath = `${path.resolve(this.fsPath)}.lock`
		const held = transactions.getStore()?.get(lockPath)
		if (held) {
			held.assertOwned()
			return Promise.resolve(operation())
		}

		const run = (release: StorageLock): Promise<R> => {
			const locks = new Map(transactions.getStore())
			locks.set(lockPath, release)
			try {
				const result = transactions.run(locks, operation)
				if (result instanceof Promise) return result.finally(release)
				release()
				return Promise.resolve(result)
			} catch (error) {
				release()
				return Promise.reject(error)
			}
		}
		// Keep uncontended writes synchronous for ClineSyncStorage callers.
		let release: StorageLock | undefined
		try {
			release = tryStorageLock(lockPath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			fs.mkdirSync(path.dirname(this.fsPath), { recursive: true })
			release = tryStorageLock(lockPath)
		}
		return release ? run(release) : acquireStorageLock(lockPath, options).then(run)
	}

	public override update(key: string, value: T | undefined): Promise<void> {
		return this.setBatch({ [key]: value })
	}

	/**
	 * Re-read the file, replacing the cached copy. Reads are otherwise served
	 * from memory for the life of the instance, so a migration that must see
	 * what other windows have saved calls this first.
	 */
	public reload(): void {
		this.data = this.readFromDiskStrict() ?? this.data
	}

	protected _keys(): readonly string[] {
		return Object.keys(this.data)
	}

	/** The file's document, or undefined when it is missing or unreadable. */
	private readFromDiskStrict(onCorrupt?: () => void): Record<string, T> | undefined {
		let raw: string
		try {
			raw = fs.readFileSync(this.fsPath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			Logger.error(`[${this.name}] failed to read from ${this.fsPath}:`, error)
			// A failed read is not evidence of corruption. Never replace it.
			if (onCorrupt) throw error
			return undefined
		}
		try {
			const parsed = JSON.parse(raw)
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
		} catch (error) {
			Logger.error(`[${this.name}] failed to parse ${this.fsPath}:`, error)
		}
		onCorrupt?.()
		return undefined
	}

	private writeToDisk(): void {
		try {
			atomicWriteFileSync(this.fsPath, JSON.stringify(this.data, null, 2), this.fileMode)
		} catch (error) {
			Logger.error(`[${this.name}] failed to write to ${this.fsPath}:`, error)
			throw error
		}
	}
}

/**
 * Synchronously, atomically write data to a file using temp file + rename pattern.
 * Prefer core/storage's async atomicWriteFile to this.
 */
function atomicWriteFileSync(filePath: string, data: string, mode?: fs.Mode | undefined): void {
	const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}.json`
	try {
		fs.writeFileSync(tmpPath, data, {
			flag: "wx",
			encoding: "utf-8",
			mode,
		})
		// Rename temp file to target (atomic in most cases)
		fs.renameSync(tmpPath, filePath)
	} catch (error) {
		// Clean up temp file if it exists
		try {
			fs.unlinkSync(tmpPath)
		} catch {}
		throw error
	}
}
