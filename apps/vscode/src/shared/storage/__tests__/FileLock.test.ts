import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClineFileStorage } from "../ClineFileStorage"
import { acquireFileLock } from "../FileLock"

let dir: string
let lockPath: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-"))
	lockPath = path.join(dir, "test.lock")
})
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true })
})

const writeLock = (record: { pid: number; at: number }) =>
	fs.writeFileSync(lockPath, JSON.stringify({ ...record, token: "other-owner" }))

describe("acquireFileLock", () => {
	it("is exclusive until released, and leaves nothing behind", async () => {
		const release = await acquireFileLock(lockPath)
		expect(release).toBeDefined()
		expect(await acquireFileLock(lockPath, { timeoutMs: 80 })).toBeUndefined()
		release?.()
		const again = await acquireFileLock(lockPath, { timeoutMs: 80 })
		expect(again).toBeDefined()
		again?.()
		expect(fs.readdirSync(dir)).toEqual([])
	})

	it("hands the lock to a waiter once the holder releases", async () => {
		const release = await acquireFileLock(lockPath)
		const waiter = acquireFileLock(lockPath, { timeoutMs: 2000, retryMs: 10 })
		setTimeout(() => release?.(), 60)
		const next = await waiter
		expect(next).toBeDefined()
		next?.()
	})

	it("reclaims a lock whose owner process has exited", async () => {
		const dead = spawnSync(process.execPath, ["--version"]).pid
		writeLock({ pid: dead, at: Date.now() })
		const release = await acquireFileLock(lockPath, { timeoutMs: 500 })
		expect(release).toBeDefined()
		release?.()
	})

	it("reclaims a lock that is too old even if its pid looks alive", async () => {
		writeLock({ pid: process.pid, at: Date.now() - 60_000 })
		expect(await acquireFileLock(lockPath, { timeoutMs: 80, staleMs: 30_000 })).toBeDefined()
	})

	it("respects a live, recent holder", async () => {
		writeLock({ pid: process.pid, at: Date.now() })
		expect(await acquireFileLock(lockPath, { timeoutMs: 80 })).toBeUndefined()
		expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).token).toBe("other-owner")
	})

	it("only releases its own lock", async () => {
		const release = await acquireFileLock(lockPath)
		writeLock({ pid: process.pid, at: Date.now() })
		release?.()
		expect(fs.existsSync(lockPath)).toBe(true)
	})
})

describe("ClineFileStorage with several instances on one file", () => {
	it("writes only its own keys, never a stale copy of the others", async () => {
		const file = path.join(dir, "state.json")
		const first = new ClineFileStorage(file)
		await first.setBatch({ shared: "v1", mine: "a" })
		const second = new ClineFileStorage(file)
		await first.setBatch({ shared: "v2" })

		await second.setBatch({ other: "b" })

		const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"))
		expect(onDisk).toEqual({ shared: "v2", mine: "a", other: "b" })
	})

	it("reload() picks up what another instance saved", async () => {
		const file = path.join(dir, "state.json")
		const first = new ClineFileStorage<string>(file)
		const second = new ClineFileStorage<string>(file)
		await first.setBatch({ key: "saved" })
		const read = (): string | undefined => second.get("key")
		expect(read()).toBeUndefined()
		second.reload()
		expect(read()).toBe("saved")
	})

	it("keeps its cache and the file when the file is unreadable", async () => {
		const file = path.join(dir, "state.json")
		const storage = new ClineFileStorage(file)
		await storage.setBatch({ a: 1 })
		fs.writeFileSync(file, "{ not json")
		await storage.setBatch({ b: 2 })
		expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ a: 1, b: 2 })
	})
})
