import { createWriteStream, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ stream: undefined as ReturnType<typeof createWriteStream> | undefined }))
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		createWriteStream: (...args: Parameters<typeof createWriteStream>) => {
			mock.stream = actual.createWriteStream(...args)
			return mock.stream
		},
	}
})

import { runScriptCommand } from "./script-runner"

describe("script log failures", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "script-log-"))
		mock.stream = undefined
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	it("rejects a real failing log open before executing anything", async () => {
		await expect(runScriptCommand({ command: "touch executed", cwd: root, env: {}, logPath: root })).rejects.toThrow()
		await expect(fs.stat(path.join(root, "executed"))).rejects.toThrow()
	})
	it.skipIf(process.platform === "win32")(
		"handles a log failure during real shell execution and settles once",
		async () => {
			const pending = runScriptCommand({
				command: "echo $$ > child.pid; while :; do echo running; sleep 0.05; done",
				cwd: root,
				env: { PATH: process.env.PATH ?? "" },
				logPath: path.join(root, "output.log"),
			})
			let settlements = 0
			const result = pending.then(
				() => {
					settlements++
					return "unexpected success"
				},
				(error) => {
					settlements++
					return error.message
				},
			)
			await expect.poll(async () => await fs.readFile(path.join(root, "child.pid"), "utf8").catch(() => "")).not.toBe("")
			mock.stream!.destroy(new Error("disk full"))
			expect(await result).toContain("Script log failed: disk full")
			expect(settlements).toBe(1)
			const pid = Number(await fs.readFile(path.join(root, "child.pid"), "utf8"))
			expect(() => process.kill(pid, 0)).toThrow()
		},
		6000,
	)
})
