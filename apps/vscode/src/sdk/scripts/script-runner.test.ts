import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runScriptCommand } from "./script-runner"

describe.skipIf(process.platform === "win32")("script process termination", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "script-kill-"))
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	it.each(["timeout", "cancel"])("escalates %s for a SIGTERM-ignoring process group and settles", async (kind) => {
		const controller = new AbortController()
		const started = Date.now()
		const pending = runScriptCommand({
			command: `trap '' TERM; sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' & wait`,
			cwd: root,
			env: { PATH: process.env.PATH ?? "" },
			logPath: path.join(root, "run.log"),
			signal: controller.signal,
			timeoutMs: kind === "timeout" ? 150 : 10000,
		})
		if (kind === "cancel") {
			await expect.poll(async () => await fs.readFile(path.join(root, "child.pid"), "utf8").catch(() => "")).not.toBe("")
			controller.abort()
		}
		const result = await pending
		expect(Date.now() - started).toBeLessThan(5000)
		expect(result.timedOut).toBe(kind === "timeout")
		expect(result.aborted).toBe(kind === "cancel")
		const pid = Number(await fs.readFile(path.join(root, "child.pid"), "utf8"))
		await expect
			.poll(() => {
				try {
					process.kill(pid, 0)
					return false
				} catch {
					return true
				}
			})
			.toBe(true)
	}, 7000)
})
