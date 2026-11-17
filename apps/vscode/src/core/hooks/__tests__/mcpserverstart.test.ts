import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { HookFactory } from "../hook-factory"
import { createHookTestEnv, createTestHook, type HookTestEnv, resetHookCache, stubHookDirs, withPlatform } from "./test-utils"

describe("McpServerStart file hook", () => {
	let env: HookTestEnv
	beforeEach(async () => {
		env = await createHookTestEnv()
	})
	afterEach(async () => {
		await env.cleanup()
	})
	const input = {
		mcpServerStart: {
			serverName: "internal",
			transportType: "stdio",
			command: "server",
			args: ["--local"],
			reason: "initial",
		},
	}
	it("discovers an enabled hook and passes metadata without a task", async () => {
		await createTestHook(
			env.tempDir,
			"McpServerStart",
			{},
			{
				customNodeCode: `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify({contextModification: JSON.stringify(input)}));
`,
			},
		)
		const runner = await new HookFactory().create("McpServerStart")
		expect(runner.isNoOp).toBe(false)
		const output = await runner.run(input)
		const payload = JSON.parse(output.contextModification!)
		expect(payload.mcpServerStart).toEqual(input.mcpServerStart)
		expect(payload.hookName).toBe("McpServerStart")
		expect(payload.clineVersion).toBeTruthy()
		expect(payload.workspaceRoots).toEqual([env.tempDir])
		expect(payload).not.toHaveProperty("taskId")
		expect(payload.model).toEqual({ provider: "unknown", slug: "unknown" })
	})
	it("ignores disabled Unix hooks", async () => {
		const hook = await createTestHook(env.tempDir, "McpServerStart", { cancel: true })
		if (process.platform === "win32") return
		await fs.chmod(hook, 0o644)
		resetHookCache()
		expect((await new HookFactory().create("McpServerStart")).isNoOp).toBe(true)
	})
	it("discovers the PowerShell filename on Windows", async () => {
		await fs.writeFile(path.join(env.hooksDir, "McpServerStart.ps1"), "'{}'")
		await withPlatform("win32", async () => {
			expect(await HookFactory.findHookInHooksDir("McpServerStart", env.hooksDir)).toBe(
				path.join(env.hooksDir, "McpServerStart.ps1"),
			)
		})
	})
	it("blocks non-zero exit even when stdout contains valid proceed JSON", async () => {
		await createTestHook(
			env.tempDir,
			"McpServerStart",
			{},
			{ customNodeCode: 'console.error("refresh failed"); console.log(JSON.stringify({cancel:false})); process.exit(3)' },
		)
		const runner = await new HookFactory().create("McpServerStart")
		await expect(runner.run(input)).rejects.toThrow("McpServerStart hook exited with code 3")
	})
	it("waits for all enabled hooks to exit when one fails", async () => {
		await createTestHook(env.tempDir, "McpServerStart", {}, { exitCode: 3 })
		const secondRoot = path.join(env.tempDir, "second")
		const marker = path.join(env.tempDir, "finished")
		await createTestHook(
			secondRoot,
			"McpServerStart",
			{},
			{
				customNodeCode: `setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'done'); console.log('{}') }, 150)`,
			},
		)
		stubHookDirs(env.sandbox, [env.hooksDir, path.join(secondRoot, ".clinerules", "hooks")])
		const runner = await new HookFactory().create("McpServerStart")
		await expect(runner.run(input)).rejects.toThrow("exited with code 3")
		expect(await fs.readFile(marker, "utf8")).toBe("done")
	})
	it("honors the existing cancel and error output contract", async () => {
		await createTestHook(env.tempDir, "McpServerStart", { cancel: true, errorMessage: "Offline" })
		const runner = await new HookFactory().create("McpServerStart")
		expect(await runner.run(input)).toMatchObject({ cancel: true, errorMessage: "Offline" })
	})
})
