import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ComposerProvenance } from "@shared/composer-provenance"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/core/storage/StateManager", () => {
	const stub: unknown = new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : vi.fn(() => undefined)) })
	return { StateManager: { get: () => stub, instance: stub } }
})
vi.mock("@/services/telemetry", () => ({
	telemetryService: new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : vi.fn()) }),
}))
vi.mock("./sdk-telemetry", async (importOriginal) => ({
	...((await importOriginal()) as object),
	createVscodeSdkTelemetryHandle: () => ({ telemetry: {}, dispose: vi.fn() }),
}))
vi.mock("@/services/mcp/McpHub", () => ({
	McpHub: class {
		getServers = () => []
		constructor() {
			return new Proxy(this, { get: (target, key) => (key in target ? Reflect.get(target, key) : vi.fn()) })
		}
	},
}))
vi.mock("@/services/auth/AuthService", () => ({ AuthService: { getInstance: () => ({}) } }))
vi.mock("@/services/auth/oca/OcaAuthService", () => ({ OcaAuthService: { initialize: () => ({}) } }))

import { Controller } from "./SdkController"
import { ScriptsHost } from "./scripts/script-host"
import { createTaskProxy } from "./task-proxy"

// The real Controller wires its coordinators in the constructor; these tests drive a
// normal follow-up through that wiring to the mention resolver, so a coordinator
// callback that drops an argument fails here rather than in a mocked coordinator.
function followUpController() {
	const controller = new Controller({ globalStorageUri: { fsPath: "/tmp/cline-provenance-test" } } as never) as any
	controller.task = createTaskProxy("current", controller.askResponse.bind(controller), controller.cancelTask.bind(controller))
	const send = vi.fn()
	const session = { sessionId: "current", isRunning: false, sdkHost: {} }
	vi.spyOn(controller.sessions, "getActiveSession").mockReturnValue(session)
	vi.spyOn(controller.sessions, "assertTaskAvailable").mockImplementation(() => {})
	vi.spyOn(controller.sessions, "markSendRunning").mockImplementation(() => {})
	vi.spyOn(controller.sessions, "fireAndForgetSend").mockImplementation(send)
	vi.spyOn(controller, "postStateToWebview").mockResolvedValue(undefined)
	vi.spyOn(controller.followups, "emitUserFeedback" as never).mockImplementation(() => {})
	controller.resolveSlashCommands = async (text: string) => text
	controller.resolveAllowListOwner = async (id: string) => id
	controller.taskHistory = {
		findHistoryItem: vi.fn(async (id: string) => ({ id, title: `Title ${id}`, task: id })),
		markTaskActive: vi.fn(async () => {}),
		addReferencedThreads: vi.fn(async () => {}),
	}
	controller.referencedThreads = new Map()
	return { controller, send }
}

describe("normal follow-ups carry composer provenance", () => {
	beforeEach(() => vi.clearAllMocks())

	it("authorizes a thread the user picked when the message is a plain follow-up", async () => {
		const { controller, send } = followUpController()
		await controller.askResponse("compare with thread:1_picked", undefined, undefined, undefined, {
			authorizedThreadIds: ["1_picked"],
		})
		expect(send).toHaveBeenCalledOnce()
		expect(send.mock.calls[0][2]).toContain('<thread_reference id="1_picked"')
		expect([...(controller.referencedThreads.get("current") ?? [])]).toEqual(["1_picked"])
	})

	it("authorizes nothing for a follow-up without picks, even if it mentions a thread", async () => {
		const { controller, send } = followUpController()
		await controller.askResponse("see thread:9_secret", undefined, undefined, undefined, undefined)
		expect(send.mock.calls[0][2]).toBe("see thread:9_secret")
		expect(controller.referencedThreads.size).toBe(0)
	})
})

describe("message tags attach one message as context", () => {
	beforeEach(() => vi.clearAllMocks())

	const tag = { threadId: "7_src", messageIndex: 3, toolCallId: "call_done" }

	it("injects the linked message with its source thread and author, ahead of the typed text", async () => {
		const { controller, send } = followUpController()
		controller.taskHistory.readSessionMessages = vi.fn(async () => [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "x" },
			{ role: "user", content: "x" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_done", name: "attempt_completion", input: { result: "All fixed." } }],
			},
		])
		await controller.askResponse("use this", undefined, undefined, undefined, { messageLinks: [tag] })
		const sent = send.mock.calls[0][2] as string
		expect(sent).toBe(
			'<message_reference thread_id="7_src" thread_title="Title 7_src" author="assistant" message_index="3" tool_call_id="call_done">\nAll fixed.\n</message_reference>\n\nuse this',
		)
	})

	it("does not authorize the thread's transcript tools or expand a thread: token", async () => {
		const { controller, send } = followUpController()
		controller.taskHistory.readSessionMessages = vi.fn(async () => [{ role: "user", content: "hello there" }])
		await controller.askResponse("see thread:7_src", undefined, undefined, undefined, {
			messageLinks: [{ threadId: "7_src", messageIndex: 0 }],
		})
		const sent = send.mock.calls[0][2] as string
		expect(sent).toContain('author="user"')
		expect(sent).toContain("hello there")
		expect(sent).toContain("see thread:7_src")
		expect(sent).not.toContain("<thread_reference")
		expect(controller.referencedThreads.size).toBe(0)
	})

	it("resends a verbatim reference as-is without resolving it again", async () => {
		const { controller, send } = followUpController()
		controller.taskHistory.readSessionMessages = vi.fn(async () => [])
		await controller.askResponse("edited", undefined, undefined, undefined, {
			messageLinks: [{ threadId: "7_src", messageIndex: 0, threadTitle: "Dev plan", author: "user", text: "Cap exports" }],
		})
		expect(send.mock.calls[0][2]).toBe(
			'<message_reference thread_id="7_src" thread_title="Dev plan" author="user" message_index="0">\nCap exports\n</message_reference>\n\nedited',
		)
		expect(controller.taskHistory.readSessionMessages).not.toHaveBeenCalled()
	})

	it("resends a verbatim reference whose position was never stored without one", async () => {
		const { controller, send } = followUpController()
		controller.taskHistory.readSessionMessages = vi.fn(async () => [])
		await controller.askResponse("edited", undefined, undefined, undefined, {
			messageLinks: [{ threadId: "7_src", messageIndex: -1, threadTitle: "Dev plan", author: "user", text: "Cap exports" }],
		})
		expect(send.mock.calls[0][2]).toBe(
			'<message_reference thread_id="7_src" thread_title="Dev plan" author="user">\nCap exports\n</message_reference>\n\nedited',
		)
	})

	it("skips a link that no longer resolves and still sends the text", async () => {
		const { controller, send } = followUpController()
		controller.taskHistory.readSessionMessages = vi.fn(async () => [])
		await controller.askResponse("just text", undefined, undefined, undefined, { messageLinks: [tag] })
		expect(send.mock.calls[0][2]).toBe("just text")
	})
})

describe("one-run script grants come only from the composer's script marker", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-script-provenance-"))
		await fs.writeFile(
			path.join(root, "deploy.md"),
			"---\ndescription: Deploy\ncommand: deploy.sh --to {{env}}\napproval: always_ask\noptions:\n  - {name: env, kind: choice, required: true, choices: [dev, prod]}\n---\n",
		)
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	async function scriptController() {
		const { controller } = followUpController()
		// Use the real slash-command resolution, which is where script text expands.
		delete controller.resolveSlashCommands
		controller.scripts = new ScriptsHost({
			getGlobalDir: () => root,
			getWorkspaceRoot: () => undefined,
			getToggles: () => ({ global: {}, workspace: {} }),
			getLogDir: () => path.join(root, "logs"),
			getTrustFile: () => path.join(root, "trust.json"),
			resolveEnv: async () => ({}),
		})
		await controller.scripts.store.trust.trust(await controller.scripts.store.find("deploy"))
		return controller
	}
	const run = { action: "run", name: "deploy", options: { env: "prod" } }
	const resolve = (controller: any, text: string, provenance?: ComposerProvenance) =>
		controller.resolveContextMentions(text, "current", provenance) as Promise<string>

	it("does not grant a run for /script text in a task-creation URI prompt", async () => {
		const controller = await scriptController()
		controller.initTask = vi.fn(async () => {})
		// vscode://.../task?prompt=/deploy env:prod ends in handleTaskCreation, which has no composer.
		await controller.handleTaskCreation("/deploy env:prod")
		expect(controller.initTask).toHaveBeenCalledWith("/deploy env:prod")

		const expanded = await resolve(controller, "/deploy env:prod")
		expect(expanded).toContain('"options":{"env":"prod"}')
		expect(expanded).not.toContain("needs no further approval")
		expect(await controller.scripts.decideApproval(run, "act", "current")).toBe("ask")
	})

	it("grants exactly one run when the composer marks the message as a script run", async () => {
		const controller = await scriptController()
		const expanded = await resolve(controller, "/deploy env:prod", {
			scriptInvocation: { name: "deploy", values: { env: "prod" } },
		})
		expect(expanded).toContain("needs no further approval")
		expect(await controller.scripts.decideApproval(run, "act", "current")).toBe("allow")
		expect(await controller.scripts.decideApproval(run, "act", "current")).toBe("ask")
	})

	it("ignores a marker whose values differ from the text", async () => {
		const controller = await scriptController()
		await resolve(controller, "/deploy env:prod", { scriptInvocation: { name: "deploy", values: { env: "dev" } } })
		expect(await controller.scripts.decideApproval(run, "act", "current")).toBe("ask")
	})
})
