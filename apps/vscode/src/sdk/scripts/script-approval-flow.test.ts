import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CoreSessionEvent } from "@cline/core"
import type { AgentEvent } from "@cline/shared"
import type { ScriptApproval } from "@shared/scripts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildToolApprovalAskMessage, MessageTranslatorState, translateSessionEvent } from "../message-translator"
import { SdkInteractionCoordinator } from "../sdk-interaction-coordinator"
import { SdkMessageCoordinator } from "../sdk-message-coordinator"
import { createTaskProxy } from "../task-proxy"
import { ScriptsHost } from "./script-host"

vi.mock("../webview-grpc-bridge", () => ({
	pushMessageToWebview: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@core/storage/disk", () => ({
	saveClineMessages: vi.fn().mockResolvedValue(undefined),
}))

describe("script approvals through the interaction coordinator", () => {
	let root: string
	let host: ScriptsHost

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-script-flow-"))
		host = new ScriptsHost({
			getGlobalDir: () => root,
			getWorkspaceRoot: () => undefined,
			getToggles: () => ({ global: {}, workspace: {} }),
			getLogDir: () => path.join(root, "logs"),
			resolveEnv: async () => ({}),
		})
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	const writeScript = (name: string, approval?: ScriptApproval) =>
		fs.writeFile(
			path.join(root, `${name}.md`),
			`---\ndescription: d\ncommand: deploy.sh --to {{env}}\n${approval ? `approval: ${approval}\n` : ""}options:\n  - {name: env, kind: choice, required: true, choices: [dev, prod]}\n---\n`,
		)

	const makeCoordinator = (mode: "plan" | "act", options: { globalAutoApprove?: boolean } = {}) => {
		const task = createTaskProxy("thread-1", vi.fn(), vi.fn())
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "thread-1",
			getMode: () => mode,
			postStateToWebview,
			shouldAutoApproveTool: () => options.globalAutoApprove === true,
			decideScriptApproval: (input, scriptMode) => host.decideApproval(input, scriptMode, "thread-1"),
		})
		const request = (input: unknown = { action: "run", name: "deploy", options: { env: "prod" } }) =>
			coordinator.handleRequestToolApproval({
				agentId: "agent",
				conversationId: "thread-1",
				iteration: 1,
				toolCallId: `call-${Math.random()}`,
				toolName: "script",
				input,
				policy: { autoApprove: false },
			})
		return { coordinator, task, request, postStateToWebview }
	}

	it.each([
		["ask_in_ask_mode", "plan", "asks"],
		["ask_in_ask_mode", "act", "runs"],
		["always_ask", "plan", "asks"],
		["always_ask", "act", "asks"],
		["always_allow", "plan", "runs"],
		["always_allow", "act", "runs"],
	] as const)("%s in %s mode %s", async (approval, mode, outcome) => {
		await writeScript("deploy", approval)
		const { coordinator, task, request, postStateToWebview } = makeCoordinator(mode)
		const pending = request()
		if (outcome === "runs") {
			await expect(pending).resolves.toEqual({ approved: true })
			expect(task.messageStateHandler.getClineMessages()).toEqual([])
			return
		}
		await vi.waitFor(() => expect(postStateToWebview).toHaveBeenCalled())
		const [ask] = task.messageStateHandler.getClineMessages()
		expect(ask.ask).toBe("tool")
		coordinator.resolvePendingToolApproval(undefined, "yesButtonClicked")
		await expect(pending).resolves.toEqual({ approved: true })
	})

	it("defaults to asking in Ask mode when the file does not set an approval", async () => {
		await writeScript("deploy")
		expect(await host.store.find("deploy")).toMatchObject({ approval: "ask_in_ask_mode" })
		const ask = makeCoordinator("plan")
		const pending = ask.request()
		await vi.waitFor(() => expect(ask.task.messageStateHandler.getClineMessages()).toHaveLength(1))
		ask.coordinator.resolvePendingToolApproval(undefined, "noButtonClicked")
		await expect(pending).resolves.toMatchObject({ approved: false })
		await expect(makeCoordinator("act").request()).resolves.toEqual({ approved: true })
	})

	it("is not bypassed by the global auto-approval toggles", async () => {
		await writeScript("deploy", "always_ask")
		const { task, request } = makeCoordinator("act", { globalAutoApprove: true })
		void request()
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))
	})

	it("shows the script name and values in the approval, never a command string", async () => {
		await writeScript("deploy", "always_ask")
		const { task, request } = makeCoordinator("act")
		void request()
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))
		const text = task.messageStateHandler.getClineMessages()[0].text ?? ""
		expect(JSON.parse(text)).toEqual({ tool: "script", scriptAction: "run", name: "deploy", scriptOptions: { env: "prod" } })
		expect(text).not.toContain("deploy.sh")
	})

	it("accepts a run the user typed into the composer, once", async () => {
		await writeScript("deploy", "always_ask")
		const instruction = await host.expandInvocation("/deploy env:prod", "thread-1")
		expect(instruction).toContain('{"action":"run","name":"deploy","options":{"env":"prod"}}')
		const { request, task } = makeCoordinator("plan")
		await expect(request()).resolves.toEqual({ approved: true })
		void request()
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))
	})

	it("does not let a typed run approve different values", async () => {
		await writeScript("deploy", "always_ask")
		await host.expandInvocation("/deploy env:dev", "thread-1")
		const { request, task } = makeCoordinator("act")
		void request({ action: "run", name: "deploy", options: { env: "prod" } })
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))
	})
})

describe("script approval ask message", () => {
	it("describes a run by name and values", () => {
		const message = buildToolApprovalAskMessage(
			"script",
			{ action: "run", name: "deploy", options: { env: "prod", dry: true } },
			1,
		)
		expect(message).toMatchObject({ type: "ask", ask: "tool" })
		expect(JSON.parse(message.text ?? "")).toEqual({
			tool: "script",
			scriptAction: "run",
			name: "deploy",
			scriptOptions: { env: "prod", dry: true },
		})
	})

	it("describes loading notes", () => {
		const message = buildToolApprovalAskMessage("script", '{"action":"load","name":"deploy"}', 1)
		expect(JSON.parse(message.text ?? "")).toEqual({ tool: "script", scriptAction: "load", name: "deploy" })
	})
})

describe("script tool rows", () => {
	const event = (type: "content_start" | "content_end", input?: unknown, output?: unknown): CoreSessionEvent => ({
		type: "agent_event",
		payload: {
			sessionId: "s1",
			event: { type, contentType: "tool", toolName: "script", toolCallId: "call-1", input, output } as AgentEvent,
		},
	})

	it("shows the run's outcome on the same row once it finishes", () => {
		const state = new MessageTranslatorState()
		const input = { action: "run", name: "deploy", options: { env: "prod" } }
		const started = translateSessionEvent(event("content_start", input), state)
		expect(JSON.parse(started.messages[0].text ?? "")).toMatchObject({ tool: "script", name: "deploy" })
		const ended = translateSessionEvent(
			event("content_end", undefined, 'Script "deploy" succeeded (exit code 0).\nNo output.\nFull log: /logs/a.log'),
			state,
		)
		const tool = JSON.parse(ended.messages[0].text ?? "")
		expect(tool).toMatchObject({ tool: "script", scriptAction: "run", name: "deploy", scriptOptions: { env: "prod" } })
		expect(tool.content).toContain("succeeded (exit code 0)")
		expect(ended.messages[0].ts).toBe(started.messages[0].ts)
	})

	it("shows a rejected run's error", () => {
		const state = new MessageTranslatorState()
		translateSessionEvent(event("content_start", { action: "run", name: "deploy", options: {} }), state)
		const ended = translateSessionEvent(event("content_end", undefined, { error: 'Option "env" is required.' }), state)
		expect(JSON.parse(ended.messages[0].text ?? "").content).toBe('Error: Option "env" is required.')
	})
})

describe("ScriptsHost.expandInvocation", () => {
	let root: string
	let host: ScriptsHost
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-script-invoke-"))
		host = new ScriptsHost({
			getGlobalDir: () => root,
			getWorkspaceRoot: () => undefined,
			getToggles: () => ({ global: {}, workspace: {} }),
			getLogDir: () => path.join(root, "logs"),
			resolveEnv: async () => ({}),
		})
		await fs.writeFile(
			path.join(root, "test-module.md"),
			"---\ndescription: Run tests\ncommand: bun test {{module}}{{#watch}} --watch{{/watch}}\noptions:\n  - {name: module, kind: choice, required: true, choices: [api, web]}\n  - {name: watch, kind: flag}\n---\n",
		)
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("turns /script options into an instruction with exactly those values", async () => {
		const text = await host.expandInvocation("/test-module module:api watch\nafter that, summarise", "t")
		expect(text).toContain("with: module:api watch")
		expect(text).toContain('"options":{"module":"api","watch":true}')
		expect(text).toContain("Note from the user: after that, summarise")
	})

	it("leaves messages alone when the script is unknown or the options are invalid", async () => {
		expect(await host.expandInvocation("/nope module:api", "t")).toBeUndefined()
		expect(await host.expandInvocation("/test-module", "t")).toBeUndefined()
		expect(await host.expandInvocation("/test-module module:zzz", "t")).toBeUndefined()
		expect(await host.expandInvocation("/test-module module:api bogus", "t")).toBeUndefined()
		expect(await host.expandInvocation("please /test-module module:api", "t")).toBeUndefined()
		expect(await host.decideApproval({ action: "run", name: "test-module", options: { module: "api" } }, "plan", "t")).toBe(
			"ask",
		)
	})
})
