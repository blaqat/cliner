import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerHandler } from "@cline/llms"
import { describe, expect, it, vi } from "vitest"
import { ClineCore } from "../../../../sdk/packages/core/dist/index.js"
import { Controller } from "./SdkController"
import { SdkTaskHistory } from "./sdk-task-history"
import { createSideThreadTools, type SideThreadContext, withSideThreadNotes } from "./side-thread-tools"

// Real runtime and persistence, with scripted inference. All state stays in a temporary data directory.
describe("side thread delivery", () => {
	it.each([
		"idle",
		"running",
		"reload",
	])("never starts a model call in an %s Main and delivers on its next turn", async (state) => {
		const dir = mkdtempSync(join(tmpdir(), "cline-side-delivery-"))
		vi.stubEnv("CLINE_DATA_DIR", dir)
		vi.stubEnv("CLINE_HOOKS_LOG_PATH", join(dir, "hooks.jsonl"))
		let core: ClineCore | undefined
		let history: SdkTaskHistory | undefined
		const started = Promise.withResolvers<void>()
		const finish = Promise.withResolvers<void>()
		const requests: string[] = []
		try {
			registerHandler("side-fixture", () => ({
				getMessages: (_system, messages) => messages,
				getModel: () => ({
					id: "fixture",
					info: { id: "fixture", contextWindow: 100_000, maxTokens: 1000, capabilities: ["tools"] as const },
				}),
				async *createMessage(_system, messages) {
					requests.push(JSON.stringify(messages))
					started.resolve()
					if (state === "running" && requests.length === 1) await finish.promise
					yield { type: "text", id: "answer", text: "Main answer" } as const
					yield { type: "done", id: "done", success: true } as const
				},
			}))
			const open = async () => {
				core = await ClineCore.create({ backendMode: "local", distinctId: "test" })
				history = new SdkTaskHistory({
					sessions: { getActiveSession: () => ({ sdkHost: core }) } as never,
					mcpHub: {} as never,
				})
			}
			await open()
			const emitted = vi.fn()
			const controller = Object.create(Controller.prototype)
			Object.assign(controller, {
				get taskHistory() {
					return history
				},
				getTaskSessionContext: () => ({
					translator: { nextTs: () => 123 },
					task: { messageStateHandler: { getClineMessages: () => [] } },
					messages: { replaceMessages: vi.fn(), emitHookMessage: emitted },
				}),
				postStateToWebview: vi.fn(async () => {}),
			})
			const resolveContext = (id: string, metadata?: Record<string, unknown>): Promise<SideThreadContext> =>
				controller.resolveSideThreadContext({ config: { sessionId: id }, sessionMetadata: metadata })
			const main = await resolveContext("main")

			const start = async (resume = false) =>
				core!.start({
					...(resume ? { initialMessages: await core!.readMessages("main") } : {}),
					interactive: true,
					source: "vscode",
					config: {
						sessionId: "main",
						providerId: "side-fixture",
						modelId: "fixture",
						apiKey: "fake",
						cwd: dir,
						systemPrompt: "Test",
						enableTools: false,
						enableSpawnAgent: false,
						enableAgentTeams: false,
						hooks: withSideThreadNotes(undefined, main),
					},
				})
			await start()
			const turn = core!.send({ sessionId: "main", prompt: "Initial question" })
			await started.promise
			if (state !== "running") await turn
			const side = await resolveContext("side", { parentTaskId: "main" })
			const tools = createSideThreadTools(side)
			const call = { sessionId: "side", agentId: "side-agent", iteration: 1 }
			expect(await tools[0].execute({}, call)).toContain("Initial question")
			expect(await tools[1].execute({ message: "The aside found useful context" }, call)).toEqual({ queued: true })
			expect(requests).toHaveLength(1)
			expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ say: "subagent_update" }))
			const rows = await history!.getClineMessages("main")
			expect(rows.filter((row) => row.say === "subagent_update")).toHaveLength(1)
			finish.resolve()
			await turn
			expect(requests).toHaveLength(1)
			expect(requests[0]).not.toContain("The aside found useful context")
			if (state === "reload") {
				await history!.dispose()
				await core!.dispose()
				await open()
				controller.taskHistory = history
				await start(true)
				expect(requests).toHaveLength(1)
				expect((await history!.getClineMessages("main")).filter((row) => row.say === "subagent_update")).toHaveLength(1)
			}
			await core!.send({ sessionId: "main", prompt: "Next user question" })
			expect(requests).toHaveLength(2)
			expect(requests[1]).toContain("The aside found useful context")
			expect(await history!.consumeSideThreadNotes("main")).toBeUndefined()
		} finally {
			finish.resolve()
			await core?.dispose()
			await history?.dispose()
			vi.unstubAllEnvs()
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
