import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { acquireStorageLock, alive, owner, StorageLockTimeoutError } from "../storage-lock"

let dir: string
let lockPath: string
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-"))
	lockPath = path.join(dir, "test.lock")
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
		output: () => stdout,
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
const lockModule = JSON.stringify(path.resolve(import.meta.dir, "../storage-lock.ts"))

describe("shared storage lock", () => {
	it("times out under a live owner regardless of age", async () => {
		const record = { ...owner(), timestamp: Date.now() - 120_000 }
		fs.mkdirSync(lockPath)
		fs.writeFileSync(path.join(lockPath, `owner-${record.token}.json`), JSON.stringify(record))
		await expect(acquireStorageLock(lockPath, { timeoutMs: 50 })).rejects.toBeInstanceOf(StorageLockTimeoutError)
		expect(fs.readdirSync(lockPath)).toEqual([`owner-${record.token}.json`])
	})

	it("never steals from a live slow child", async () => {
		const holder = child(`import { acquireStorageLock } from ${lockModule};
			await acquireStorageLock(${JSON.stringify(lockPath)}); console.log('ready'); setInterval(() => {}, 1000);`)
		try {
			await holder.ready()
			const old = new Date(0)
			fs.lutimesSync(lockPath, old, old)
			await expect(acquireStorageLock(lockPath, { timeoutMs: 100 })).rejects.toBeInstanceOf(StorageLockTimeoutError)
			expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true)
		} finally {
			holder.proc.kill("SIGKILL")
			await holder.done
		}
	})

	it("serializes real waiters recovering an abandoned lock", async () => {
		const holder = child(`import { acquireStorageLock } from ${lockModule};
			await acquireStorageLock(${JSON.stringify(lockPath)}); console.log('ready'); setInterval(() => {}, 1000);`)
		await holder.ready()
		holder.proc.kill("SIGKILL")
		await holder.done
		const abandoned = { pid: holder.proc.pid, token: "abandoned-recovery", timestamp: 0 }
		const gate = `${lockPath}.recovery`
		fs.mkdirSync(gate)
		fs.writeFileSync(path.join(gate, `owner-${abandoned.token}.json`), JSON.stringify(abandoned))
		const workers = Array.from({ length: 6 }, () =>
			child(`
			import fs from 'node:fs'; import { acquireStorageLock } from ${lockModule};
			for (let i = 0; i < 4; i++) {
				const release = await acquireStorageLock(${JSON.stringify(lockPath)});
				const active = ${JSON.stringify(path.join(dir, "active"))};
				fs.writeFileSync(active, '', {flag:'wx'});
				await Bun.sleep(10); release.assertOwned(); fs.unlinkSync(active); release();
			}`),
		)
		await Promise.all(workers.map((worker) => worker.done))
		expect(fs.readdirSync(dir)).toEqual([])
	}, 20_000)

	it("recognizes pid reuse and fences assertion and release", async () => {
		expect(await alive({ ...owner(), processStart: `${process.platform === "win32" ? "ticks" : "ps-utc"}:different` })).toBe(
			false,
		)
		const release = await acquireStorageLock(lockPath)
		fs.rmSync(lockPath, { recursive: true })
		const successor = await acquireStorageLock(lockPath)
		expect(() => release.assertOwned()).toThrow("ownership was lost")
		release()
		successor.assertOwned()
		successor()
	})
})

it.skipIf(process.platform === "win32")(
	"bounds stalled identity lookups without blocking and caches failures per pid",
	async () => {
		const attempts = path.join(dir, "attempts")
		const ps = path.join(dir, "ps")
		fs.writeFileSync(
			ps,
			`#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(attempts)}, 'lookup\\n'); setTimeout(() => process.exit(0), 3000);`,
			{ mode: 0o700 },
		)
		const worker = child(`
		process.env.PATH = ${JSON.stringify(dir)};
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		const began = Date.now();
		const { alive, owner } = await import(${lockModule});
		const record = { ...owner(), processStart: 'ps-utc:unknown' };
		const results = await Promise.all(Array.from({length: 4}, () => alive(record)));
		results.push(await alive(record));
		clearInterval(timer);
		console.log(JSON.stringify({results, ticks, elapsed: Date.now() - began}));
	`)
		await worker.done
		const result = JSON.parse(worker.output())
		expect(result.results).toEqual([true, true, true, true, true])
		expect(result.ticks).toBeGreaterThan(5)
		expect(result.elapsed).toBeLessThan(2000)
		expect(fs.readFileSync(attempts, "utf8").trim().split("\n")).toHaveLength(1)
	},
)

it.skipIf(process.platform === "win32")("confirms a cached identity mismatch before declaring a live owner dead", async () => {
	const identity = path.join(dir, "identity")
	fs.writeFileSync(identity, "first")
	fs.writeFileSync(
		path.join(dir, "ps"),
		`#!${process.execPath}\nimport fs from 'node:fs'; console.log(fs.readFileSync(${JSON.stringify(identity)}, 'utf8'));`,
		{ mode: 0o700 },
	)
	const worker = child(`
		process.env.PATH = ${JSON.stringify(dir)};
		const fs = await import('node:fs');
		const { alive, owner } = await import(${lockModule});
		if (!await alive({ ...owner(), processStart: 'ps-utc:first' })) throw new Error('first owner lost');
		fs.writeFileSync(${JSON.stringify(identity)}, 'second');
		if (!await alive({ ...owner(), processStart: 'ps-utc:second' })) throw new Error('cached identity stole live owner');
	`)
	await worker.done
})
