import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentToolContext } from "@cline/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveConfiguredTerminalEnv } from "@/utils/terminal-env"
import { createVscodeExtraTools } from "../vscode-runtime-builder"
import { runScriptCommand } from "./script-runner"
import { ScriptStore } from "./script-store"
import { buildScriptInvocationInstruction, createScriptTool } from "./script-tool"

const posix = process.platform !== "win32"

describe.skipIf(!posix)("script tool", () => {
	let root: string
	let scriptsDir: string
	let workspace: string
	let logDir: string
	let terminalEnvironment: { variables?: Record<string, string>; pathEntries?: string[] } | undefined

	const writeScript = (name: string, frontmatter: string, body = "") =>
		fs.writeFile(path.join(scriptsDir, `${name}.md`), `---\ndescription: ${name} script\n${frontmatter}---\n${body}`)

	const makeTool = () =>
		createScriptTool({
			store: new ScriptStore({
				getGlobalDir: () => scriptsDir,
				getWorkspaceRoot: () => workspace,
				getToggles: () => ({ global: {}, workspace: {} }),
			}),
			getWorkspaceRoot: () => workspace,
			// The same helper every other command Cline runs uses, fed from in-memory settings.
			resolveEnv: async (cwd) =>
				(
					await resolveConfiguredTerminalEnv(
						{ getGlobalStateKey: () => terminalEnvironment, getWorkspaceStateKey: () => undefined },
						{ cwd, baseEnv: { PATH: process.env.PATH ?? "" } },
					)
				).env,
			logDir,
		})
	const run = async (name: string, options?: Record<string, string | boolean>) =>
		(await makeTool().execute({ action: "run", name, options }, {} as AgentToolContext)) as string | { error: string }

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-script-tool-"))
		scriptsDir = path.join(root, "scripts")
		workspace = path.join(root, "repo")
		logDir = path.join(root, "logs")
		terminalEnvironment = undefined
		await fs.mkdir(scriptsDir, { recursive: true })
		await fs.mkdir(workspace, { recursive: true })
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("runs the saved command with substituted, quoted values and reports the exit code", async () => {
		await writeScript(
			"greet",
			"command: printf '%s|' {{who}}{{#loud}} LOUD{{/loud}}\noptions:\n  - {name: who, kind: text, required: true}\n  - {name: loud, kind: flag}\n",
		)
		const result = (await run("greet", { who: "big world $(echo no)", loud: true })) as string
		expect(result).toContain('Script "greet" succeeded (exit code 0).')
		// printf reuses its format per argument; the value stays one literal word (no command substitution).
		expect(result.split("\n")).toContain("big world $(echo no)|LOUD|")
	})

	it("returns a failing exit code and the output", async () => {
		await writeScript("boom", "command: echo oops; exit 3\n")
		const result = (await run("boom")) as string
		expect(result).toContain('Script "boom" failed (exit code 3).')
		expect(result).toContain("oops")
	})

	it("returns the last 100 lines and saves the full log in the log folder", async () => {
		await writeScript("many", "command: seq 1 250\n")
		const result = (await run("many")) as string
		expect(result).toContain("Output (last 100 of 250 lines):")
		const lines = result.split("\n")
		expect(lines).toContain("151")
		expect(lines).toContain("250")
		expect(lines).not.toContain("150")
		const logPath = /Full log: (.+?) \(read it for earlier output\)/.exec(result)?.[1]
		expect(logPath).toBeDefined()
		expect(path.dirname(logPath as string)).toBe(logDir)
		const log = await fs.readFile(logPath as string, "utf8")
		expect(log.startsWith("$ seq 1 250\n")).toBe(true)
		expect(log.split("\n")).toContain("1")
		expect(log.split("\n")).toContain("250")
	})

	it("captures stderr and a final line without a newline", async () => {
		await writeScript("mixed", "command: echo out; echo err 1>&2; printf last\n")
		const result = (await run("mixed")) as string
		expect(result).toContain("Output (3 lines):")
		for (const line of ["out", "err", "last"]) expect(result.split("\n")).toContain(line)
	})

	it("runs with the configured terminal environment: variables, .env-style layers and PATH additions", async () => {
		const binDir = path.join(root, "bin")
		await fs.mkdir(binDir)
		await fs.writeFile(path.join(binDir, "hello-tool"), '#!/bin/sh\necho "tool says $TOOL_GREETING"\n', { mode: 0o755 })
		terminalEnvironment = { variables: { TOOL_GREETING: "hi from settings" }, pathEntries: [binDir] }
		await writeScript("envy", "command: hello-tool\n")
		const result = (await run("envy")) as string
		expect(result).toContain("tool says hi from settings")
	})

	it("passes the env helper's output to the runner, scoped to the script's cwd", async () => {
		await fs.mkdir(path.join(workspace, "sub"))
		await writeScript("where", "command: pwd\ncwd: sub\n")
		const result = (await run("where")) as string
		expect(result.split("\n")).toContain(await fs.realpath(path.join(workspace, "sub")))
	})

	it("rejects bad input without running anything or writing a log", async () => {
		await writeScript(
			"strict",
			"command: echo {{mode}}\noptions:\n  - {name: mode, kind: choice, required: true, choices: [a, b]}\n",
		)
		expect(await run("strict", { mode: "c" })).toMatchObject({ error: expect.stringContaining("must be one of: a, b") })
		expect(await run("strict", { mode: "a", extra: "x" })).toMatchObject({
			error: expect.stringContaining('Unknown option "extra"'),
		})
		expect(await run("strict")).toMatchObject({ error: 'Option "mode" is required.' })
		expect(await run("ghost")).toMatchObject({ error: expect.stringContaining('No enabled script named "ghost"') })
		await expect(fs.readdir(logDir)).rejects.toThrow()
	})

	it("reports a missing cwd", async () => {
		await writeScript("lost", "command: echo hi\ncwd: nowhere\n")
		expect(await run("lost")).toMatchObject({ error: expect.stringContaining("cwd does not exist") })
	})

	it("loads the usage notes, options and file path", async () => {
		await writeScript(
			"documented",
			"command: echo {{who}}\napproval: always_ask\noptions:\n  - {name: who, kind: text, required: true, description: Who to greet}\n",
			"Use this to greet people.\n",
		)
		const loaded = (await makeTool().execute({ action: "load", name: "documented" }, {} as AgentToolContext)) as string
		expect(loaded).toContain("Use when: documented script")
		expect(loaded).toContain(`File: ${path.join(scriptsDir, "documented.md")}`)
		expect(loaded).toContain("Approval: Always ask")
		expect(loaded).toContain("- who (text; required): Who to greet")
		expect(loaded).toContain("Use this to greet people.")
	})

	it("puts a cheap index of enabled scripts into the tool description", async () => {
		await writeScript("one", "command: echo 1\n")
		await writeScript("two", "command: echo 2\n")
		const tool = makeTool()
		await tool.execute({ action: "load", name: "one" }, {} as AgentToolContext)
		expect(tool.description).toContain("- one: one script")
		expect(tool.description).toContain("- two: two script")
		expect(tool.description).not.toContain("echo 1")
	})

	it("is registered by the extra tools builder only when scripts are provided, and not for subagents", async () => {
		const hub = { getServers: () => [] } as never
		const context = {
			store: new ScriptStore({ getWorkspaceRoot: () => undefined, getToggles: () => ({ global: {}, workspace: {} }) }),
			getWorkspaceRoot: () => workspace,
			resolveEnv: async () => ({}),
			logDir,
		}
		expect((await createVscodeExtraTools(hub, {})).map((tool) => tool.name)).not.toContain("script")
		const tools = await createVscodeExtraTools(hub, { scripts: context })
		const scriptTool = tools.find((tool) => tool.name === "script")
		expect(scriptTool).toBeDefined()
		expect(scriptTool?.metadata?.subagentAccess).toBeUndefined()
	})
})

describe.skipIf(!posix)("runScriptCommand", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-script-runner-"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("stops a command that times out", async () => {
		const result = await runScriptCommand({
			command: "echo started; sleep 30",
			cwd: dir,
			env: { PATH: process.env.PATH ?? "" },
			logPath: path.join(dir, "t.log"),
			timeoutMs: 300,
		})
		expect(result.timedOut).toBe(true)
		expect(result.tail).toContain("started")
	})

	it("stops a command when the run is cancelled", async () => {
		const controller = new AbortController()
		setTimeout(() => controller.abort(), 200)
		const result = await runScriptCommand({
			command: "sleep 30",
			cwd: dir,
			env: { PATH: process.env.PATH ?? "" },
			logPath: path.join(dir, "c.log"),
			signal: controller.signal,
		})
		expect(result.aborted).toBe(true)
	})

	it("strips terminal colors from the tail but keeps them in the log", async () => {
		const result = await runScriptCommand({
			command: "printf '\\033[31mred\\033[0m\\n'",
			cwd: dir,
			env: { PATH: process.env.PATH ?? "" },
			logPath: path.join(dir, "a.log"),
		})
		expect(result.tail).toBe("red")
		expect(await fs.readFile(path.join(dir, "a.log"), "utf8")).toContain("\u001b[31mred")
	})

	it("reports a missing working directory instead of throwing", async () => {
		const result = await runScriptCommand({
			command: "echo hi",
			cwd: path.join(dir, "missing"),
			env: { PATH: process.env.PATH ?? "" },
			logPath: path.join(dir, "m.log"),
		})
		expect(result.exitCode).toBeNull()
		expect(result.tail).toContain("Failed to start")
	})
})

describe("buildScriptInvocationInstruction", () => {
	it("tells the agent to run exactly the typed values and that approval is given", () => {
		const text = buildScriptInvocationInstruction(
			{
				name: "test-module",
				description: "d",
				command: "bun test {{module}}",
				approval: "always_ask",
				options: [
					{ name: "module", kind: "choice", required: true, description: "", choices: ["api"] },
					{ name: "watch", kind: "flag", required: false, description: "" },
				],
				notes: "",
				filePath: "/x.md",
				scope: "global",
			},
			{ module: "api", watch: true },
			"then summarise failures",
		)
		expect(text).toContain('ran the saved script "test-module" with: module:api watch')
		expect(text).toContain('{"action":"run","name":"test-module","options":{"module":"api","watch":true}}')
		expect(text).toContain("needs no further approval")
		expect(text).toContain("Note from the user: then summarise failures")
		expect(text).not.toContain("bun test")
	})
})
