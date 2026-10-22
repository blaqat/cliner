import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerHandler } from "@cline/llms"
import { describe, expect, it, vi } from "vitest"
import { ClineCore } from "../../../../sdk/packages/core/dist/index.js"
import { restoredThreadStatus } from "./sdk-restored-status"
import { SdkTaskHistory } from "./sdk-task-history"

// Only inference is scripted. Core persists, aborts and reloads real temp storage.
describe("VS Code session shutdown and restart", () => {
	it.each(["done", "waiting", "stopped"] as const)("restores a %s thread", async (expected) => {
		const dir = mkdtempSync(join(tmpdir(), "cline-runtime-reload-"))
		vi.stubEnv("CLINE_DATA_DIR", dir)
		vi.stubEnv("CLINE_HOOKS_LOG_PATH", join(dir, "hooks.jsonl"))
		let core: ClineCore | undefined
		let reopened: ClineCore | undefined
		let history: SdkTaskHistory | undefined
		const pending = Promise.withResolvers<void>()
		try {
			registerHandler("reload-fixture", () => ({
				getMessages: (_system, messages) => messages,
				getModel: () => ({
					id: "fixture",
					info: { id: "fixture", contextWindow: 100_000, maxTokens: 1000, capabilities: ["tools"] as const },
				}),
				async *createMessage() {
					if (expected === "done") yield { type: "text", id: "answer", text: "Finished" } as const
					else
						yield {
							type: "tool_calls",
							id: "read",
							tool_call: {
								call_id: "read",
								function: { name: "read_files", arguments: { paths: [join(dir, "fixture")] } },
							},
						} as const
				},
			}))
			core = await ClineCore.create({
				backendMode: "local",
				clientName: "reload-test",
				distinctId: "test",
				toolPolicies: { read_files: { autoApprove: false } },
				capabilities: {
					requestToolApproval: async (request) => {
						await history!.saveThreadStatus("thread", expected === "waiting" ? "waiting" : "running")
						pending.resolve()
						return new Promise<{ approved: boolean; reason: string }>((resolve) => {
							const abort = () => resolve({ approved: false, reason: "Host shutdown" })
							if (request.signal?.aborted) abort()
							else request.signal?.addEventListener("abort", abort, { once: true })
						})
					},
				},
			})
			history = new SdkTaskHistory({
				sessions: { getActiveSession: () => ({ sdkHost: core }) } as never,
				mcpHub: {} as never,
			})
			await core.start({
				interactive: true,
				source: "vscode",
				config: {
					sessionId: "thread",
					providerId: "reload-fixture",
					modelId: "fixture",
					apiKey: "fake",
					cwd: dir,
					systemPrompt: "Test",
					enableTools: expected !== "done",
					enableSpawnAgent: false,
					enableAgentTeams: false,
				},
			})
			const turn = core.send({ sessionId: "thread", prompt: "Test shutdown" })
			if (expected === "done") {
				await turn
				await history.saveThreadStatus("thread", "done")
			} else await pending.promise
			await history.flushMetadataWrites()
			await core.dispose("window reload")
			await turn
			await history.dispose()
			reopened = await ClineCore.create({ backendMode: "local", distinctId: "test" })
			const record = (await reopened.listHistory()).find((record) => record.sessionId === "thread")
			expect(record).toBeDefined()
			expect(restoredThreadStatus(record!)).toBe(expected)
			expect(record?.status).not.toBe("failed")
		} finally {
			await core?.dispose()
			await history?.dispose()
			await reopened?.dispose()
			vi.unstubAllEnvs()
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
