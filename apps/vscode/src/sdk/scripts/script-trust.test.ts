import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentToolContext } from "@cline/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ToolApprovalRequest } from "../sdk-interaction-coordinator"
import { ScriptsHost } from "./script-host"
import { ScriptTrustStore, scriptFingerprint } from "./script-trust"

describe.skipIf(process.platform === "win32")("script trust and approval binding with real execution", () => {
	let root: string
	let file: string
	let host: ScriptsHost
	let call = 0
	const write = (command = "printf approved > result", extra = "") =>
		fs.writeFile(file, `---\nname: deploy\ndescription: deploy\ncommand: ${command}\napproval: always_allow\n${extra}---\n`)
	const request = (name = "deploy"): ToolApprovalRequest => ({
		agentId: "agent",
		conversationId: "thread",
		iteration: 1,
		toolCallId: String(++call),
		toolName: "script",
		input: { action: "run", name },
		policy: {},
	})
	const execute = (req: ToolApprovalRequest) => host.createTool(root).execute(req.input, req as AgentToolContext)
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "script-trust-"))
		file = path.join(root, "deploy.md")
		host = new ScriptsHost({
			getGlobalDir: () => root,
			getWorkspaceRoot: () => root,
			getToggles: () => ({ global: {}, workspace: {} }),
			getLogDir: () => path.join(root, "logs"),
			getTrustFile: () => path.join(root, "storage", "trust.json"),
			resolveEnv: async () => ({ PATH: process.env.PATH ?? "" }),
		})
		await write()
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	it.each([
		"deploy",
		"/deploy",
		" deploy ",
	])("requires approval for an unreviewed %s and executes only after run once", async (name) => {
		const req = request(name)
		expect(await host.prepareApproval(req, "act", "thread")).toMatchObject({
			decision: "ask",
			review: { scriptCommand: "printf approved > result", scriptCwd: root },
		})
		expect(await execute(req)).toMatchObject({ error: expect.stringContaining("No approval") })
		const next = request(name)
		await host.prepareApproval(next, "act", "thread")
		await host.completeApproval(next, true, false)
		expect(await execute(next)).toContain("succeeded")
		expect(await fs.readFile(path.join(root, "result"), "utf8")).toBe("approved")
		expect(await host.store.trust.isTrusted((await host.store.find("deploy"))!)).toBe(false)
	})
	it("persists exact trust outside scripts and invalidates it on material edits", async () => {
		const req = request()
		await host.prepareApproval(req, "act", "thread")
		await host.completeApproval(req, true, true)
		expect(await host.prepareApproval(request(), "act", "thread")).toMatchObject({ decision: "allow" })
		expect(JSON.parse(await fs.readFile(path.join(root, "storage", "trust.json"), "utf8"))[file]).toBe(
			scriptFingerprint((await host.store.find("deploy"))!),
		)
		expect(
			await new ScriptTrustStore(() => path.join(root, "storage", "trust.json")).isTrusted(
				(await host.store.find("deploy"))!,
			),
		).toBe(true)
		await fs.mkdir(path.join(root, "logs"), { recursive: true })
		for (const extra of ["cwd: logs\n", "options: [{name: arg, kind: text}]\n"]) {
			await write(undefined, extra)
			expect(await host.prepareApproval(request(), "act", "thread")).toMatchObject({ decision: "ask" })
		}
		await write("printf changed > result")
		expect(await host.prepareApproval(request(), "act", "thread")).toMatchObject({ decision: "ask" })
	})
	it("rejects changes while a manual approval is pending and after it was approved", async () => {
		const req = request()
		await host.prepareApproval(req, "act", "thread")
		await write("printf unsafe > result")
		await expect(host.completeApproval(req, true, true)).rejects.toThrow("changed")
		expect(await execute(req)).toMatchObject({ error: expect.any(String) })
		const next = request()
		await host.prepareApproval(next, "act", "thread")
		await host.completeApproval(next, true, false)
		await write("printf later > result")
		expect(await execute(next)).toMatchObject({ error: expect.stringContaining("changed") })
		await expect(fs.stat(path.join(root, "result"))).rejects.toThrow()
	})
	it("binds typed grants to the definition and refuses workspace shadowing", async () => {
		await host.store.trust.trust((await host.store.find("deploy"))!)
		await host.expandInvocation("/deploy", "thread")
		await fs.mkdir(path.join(root, ".clinerules", "scripts"), { recursive: true })
		await fs.writeFile(path.join(root, ".clinerules", "scripts", "deploy.md"), await fs.readFile(file))
		expect(await host.prepareApproval(request(), "act", "thread")).toMatchObject({ decision: "reject" })
		await fs.rm(path.join(root, ".clinerules"), { recursive: true })
		const req = request()
		expect(await host.prepareApproval(req, "act", "thread")).toMatchObject({ decision: "allow" })
		await write("printf unsafe > result")
		expect(await execute(req)).toMatchObject({ error: expect.stringContaining("changed") })
		await expect(fs.stat(path.join(root, "result"))).rejects.toThrow()
	})
	it("rejects an unknown script even if a file appears before execution", async () => {
		const req = request("missing")
		await host.prepareApproval(req, "act", "thread")
		await fs.writeFile(path.join(root, "missing.md"), "---\ndescription: d\ncommand: touch result\n---\n")
		expect(await execute(req)).toMatchObject({ error: expect.any(String) })
		await expect(fs.stat(path.join(root, "result"))).rejects.toThrow()
	})
	it("executes the approved cwd snapshot even if the tool context changes", async () => {
		const folder = path.join(root, "approved-cwd")
		await fs.mkdir(folder)
		const req = request()
		expect(await host.prepareApproval(req, "act", "thread", folder)).toMatchObject({ review: { scriptCwd: folder } })
		await host.completeApproval(req, true, false)
		expect(await execute(req)).toContain("succeeded")
		expect(await fs.readFile(path.join(folder, "result"), "utf8")).toBe("approved")
		await expect(fs.stat(path.join(root, "result"))).rejects.toThrow()
	})
})
