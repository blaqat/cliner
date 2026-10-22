import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClineFileStorage } from "../ClineFileStorage"

let dir: string
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function child(code: string) {
	const proc = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] })
	let stdout = ""
	let stderr = ""
	proc.stdout.on("data", (data) => {
		stdout += data
	})
	proc.stderr.on("data", (data) => {
		stderr += data
	})
	const done = new Promise<void>((resolve, reject) => {
		proc.once("error", reject)
		proc.once("exit", (code, signal) =>
			code === 0 || signal === "SIGKILL" ? resolve() : reject(new Error(stderr || `exit ${code}`)),
		)
	})
	return {
		proc,
		done,
		ready: async () => {
			const deadline = Date.now() + 5000
			while (!stdout.includes("ready")) {
				if (proc.exitCode !== null || Date.now() > deadline) throw new Error(stderr || "child not ready")
				await Bun.sleep(10)
			}
		},
	}
}
const storageModule = JSON.stringify(path.resolve(import.meta.dir, "../ClineFileStorage.ts"))

describe("settings writers", () => {
	it("merges keys from real processes", async () => {
		const file = path.join(dir, "state.json")
		const workers = Array.from({ length: 5 }, (_, worker) =>
			child(`
			import { ClineFileStorage } from ${storageModule};
			const storage = new ClineFileStorage(${JSON.stringify(file)});
			for (let i = 0; i < 15; i++) { await storage.setBatch({[${JSON.stringify(`worker-${worker}-`)} + i]: i}); await Bun.sleep(2); }`),
		)
		await Promise.all(workers.map((worker) => worker.done))
		expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")))).toHaveLength(75)
	}, 20_000)

	it("holds read through migration commit against an unrelated-key writer", async () => {
		const file = path.join(dir, "state.json")
		const migration = new ClineFileStorage(file)
		const writer = new ClineFileStorage(file)
		let pending: Promise<void> | undefined
		await migration.withLock(async () => {
			migration.reload()
			// Start outside the transaction's async context, like another window.
			pending = new Promise((resolve, reject) => {
				const worker = child(`import { ClineFileStorage } from ${storageModule};
					await new ClineFileStorage(${JSON.stringify(file)}).setBatch({unrelated:'saved'});`)
				worker.done.then(resolve, reject)
			})
			await Bun.sleep(150)
			expect(fs.existsSync(file)).toBe(false)
			await migration.setBatch({ profiles: ["migrated"], marker: 1 })
		})
		await pending
		writer.reload()
		const unrelated = () => writer.get<string>("unrelated")
		expect(unrelated()).toBe("saved")
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ profiles: ["migrated"], marker: 1, unrelated: "saved" })
	})

	it("reloads another instance's committed state", async () => {
		const file = path.join(dir, "state.json")
		const first = new ClineFileStorage(file)
		const second = new ClineFileStorage(file)
		await first.setBatch({ key: "saved" })
		expect(second.get("key")).toBeUndefined()
		second.reload()
		const saved = () => second.get<string>("key")
		expect(saved()).toBe("saved")
	})

	it("preserves corrupt bytes before rewriting from cache", async () => {
		const file = path.join(dir, "state.json")
		const storage = new ClineFileStorage(file)
		await storage.setBatch({ a: 1 })
		fs.writeFileSync(file, "{ not json")
		await storage.setBatch({ b: 2 })
		const backups = fs.readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"))
		expect(backups).toHaveLength(1)
		expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe("{ not json")
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1, b: 2 })
	})
})
