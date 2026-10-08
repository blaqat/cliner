import { describe, expect, it, vi } from "vitest"
import { getSessionApiSnapshot } from "./cline-session-factory"
import { Controller as SdkController } from "./SdkController"
import { compactSessionMessages } from "./sdk-compaction"
import { SdkCompactionCoordinator } from "./sdk-compaction-coordinator"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import { SdkSessionConfigChangeCoordinator } from "./sdk-session-config-change-coordinator"

vi.mock("./hooks-adapter", () => ({ buildAgentHooks: () => ({}) }))
vi.mock("./sdk-compaction", () => ({ compactSessionMessages: vi.fn(async () => ({ compacted: false })) }))
vi.mock("./cline-session-factory", () => ({
	getSessionApiSnapshot: (config: any) => config?.apiSnapshot,
	buildStartSessionInput: (config: any, input: any) => ({
		config,
		interactive: true,
		sessionMetadata: { apiSelection: config.apiSnapshot?.selection, taskMode: input.mode },
	}),
	createHistoryItemFromSession: vi.fn(),
	buildSessionConfig: vi.fn(async (input) => ({
		cwd: input.cwd,
		mode: input.mode,
		providerId: input.apiConfiguration[`${input.mode}ModeApiProvider`],
		modelId:
			input.apiConfiguration[`${input.mode}ModeApiModelId`] ?? input.apiConfiguration[`${input.mode}ModeOpenAiModelId`],
		providerConfig: { providerId: input.apiConfiguration[`${input.mode}ModeApiProvider`] },
	})),
}))

function fixture() {
	const profiles = [
		{ id: "P", name: "Settings", provider: "openai", modelId: "p-model" },
		{ id: "Q", name: "Chat", provider: "anthropic", modelId: "q-model" },
	]
	const selection = { askProfileId: "Q", actProfileId: "Q", actModeReasoningEffort: "high" as const }
	const stateManager = {
		getGlobalSettingsKey: () => "act",
		getGlobalStateKey: (key: string) => (key === "apiConfigProfiles" ? profiles : "P"),
		getApiConfiguration: () => ({ actModeApiProvider: "openai", actModeOpenAiModelId: "p-model" }),
		listSecretStorageKeys: () => [],
		getSecretForKey: () => undefined,
	}
	const builder = new SdkSessionConfigBuilder({ stateManager: stateManager as never, emitHookMessage: vi.fn() })
	return { selection, stateManager, builder }
}

describe("derived chat configuration", () => {
	it.each(["edit", "checkpoint"])("keeps Q's provider in %s while Settings uses P", async (operation) => {
		const { selection, stateManager, builder } = fixture()
		const settingsConfig = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(settingsConfig.providerId).toBe("openai")
		const sourceConfig = await builder.build({ cwd: "/workspace", mode: "act", apiSelection: selection })
		expect(sourceConfig.providerId).toBe("anthropic")
		const start = vi.fn(async (_input: unknown) => {
			throw new Error("captured derived session")
		})
		const host = {
			readLiveMessages: async () => [
				{ role: "user", content: "original" },
				{ role: "assistant", content: "answer" },
			],
			get: async () => ({ cwd: "/workspace" }),
		}
		const controller = {
			stateManager,
			sessionConfigBuilder: builder,
			task: {
				taskId: "chat",
				messageStateHandler: { getClineMessages: () => [{ ts: 1, type: "say", say: "task", text: "original" }] },
			},
			taskSessions: new Map([["chat", { apiSelection: selection }]]),
			sessions: {
				getActiveSession: () => ({
					sessionId: "chat",
					sdkHost: host,
					isRunning: false,
					apiSnapshot: getSessionApiSnapshot(sourceConfig),
				}),
				startNewSession: start,
				restoreActiveSession: start,
			},
			taskHistory: { findHistoryItem: async () => ({ apiSelection: selection }) },
			getWorkspaceRoot: async () => "/workspace",
			resolveContextMentions: async (text: string) => text,
			interactions: { clearPending: vi.fn() },
		}
		const action =
			operation === "edit"
				? SdkController.prototype.editMessageAndRegenerate.call(controller as never, { messageTs: 1, text: "edited" })
				: SdkController.prototype.restoreCheckpoint.call(controller as never, {
						checkpointRunCount: 1,
						restoreType: "task",
					})
		await expect(action).rejects.toThrow("captured derived session")
		const input: any = start.mock.calls[0]?.[0]
		const derived = operation === "edit" ? input : input.start
		expect(derived.config.providerId).toBe("anthropic")
		expect(derived.config.modelId).toBe("q-model")
		expect(derived.sessionMetadata.apiSelection).toEqual(selection)
	})

	it("inherits the source selection when creating an aside in Ask mode", async () => {
		const { selection, stateManager, builder } = fixture()
		const start = vi.fn(async (_input: unknown) => {
			throw new Error("captured aside")
		})
		const messages = [{ ts: 1, type: "say", say: "task", text: "original", sdkMessageIndex: 0 }]
		const controller = {
			stateManager,
			sessionConfigBuilder: builder,
			task: { taskId: "chat" },
			taskSessions: new Map([
				["chat", { apiSelection: selection, task: { messageStateHandler: { getClineMessages: () => messages } } }],
			]),
			taskHistory: {
				findHistoryItem: async () => ({ id: "chat", cwdOnTaskInitialization: "/workspace", apiSelection: selection }),
			},
			sessionRebuilds: { runExclusive: (run: () => Promise<void>) => run() },
			sessions: {
				assertTaskAvailable: vi.fn(),
				focusSession: vi.fn(),
				startNewSession: start,
				getSession: () => ({ sdkHost: { readLiveMessages: async () => [{ role: "user", content: "original" }] } }),
			},
		}
		await expect(SdkController.prototype.forkTaskAt.call(controller as never, "chat", 1)).rejects.toThrow("captured aside")
		const input: any = start.mock.calls[0][0]
		expect(input.config.providerId).toBe("anthropic")
		expect(getSessionApiSnapshot(input.config)?.selection).toEqual(selection)
		expect(getSessionApiSnapshot(input.config)?.configuration.planModeApiProvider).toBe("anthropic")
		expect(input.sessionMetadata.apiSelection).toEqual(selection)
	})

	it.each(["terminal", "checkpoints", "subagents"])("keeps Q when rebuilding for %s settings", async (reason) => {
		const { selection, stateManager, builder } = fixture()
		const config = await builder.build({ cwd: "/workspace", mode: "act", apiSelection: selection })
		const session = {
			sessionId: "chat",
			sdkHost: {},
			isRunning: false,
			queuedPromptCount: 0,
			apiSnapshot: getSessionApiSnapshot(config),
			startConfig: config,
		}
		let scheduled!: (context: { isCurrent: () => boolean }) => Promise<void>
		const replace = vi.fn(async (_input: unknown) => undefined)
		const coordinator = new SdkSessionConfigChangeCoordinator({
			stateManager,
			sessionConfigBuilder: builder,
			sessions: { getActiveSession: () => session, replaceActiveSession: replace },
			messages: { emitSessionEvents: vi.fn() },
			getWorkspaceRoot: async () => "/workspace",
			loadInitialMessages: async () => [],
			buildStartSessionInput: (config: unknown) => ({ config }),
			postStateToWebview: vi.fn(),
			rebuilds: {
				request: (_reason: string, run: typeof scheduled) => {
					scheduled = run
				},
			},
		} as never)
		if (reason === "terminal") coordinator.handleTerminalExecutionModeChanged("backgroundExec", "vscodeTerminal")
		else if (reason === "checkpoints") coordinator.handleCheckpointsSettingChanged(false, true)
		else coordinator.handleSubagentSettingsChanged()
		await scheduled({ isCurrent: () => true })
		expect(replace).toHaveBeenCalledWith(
			expect.objectContaining({
				startInput: expect.objectContaining({
					config: expect.objectContaining({
						providerId: "anthropic",
						modelId: "q-model",
					}),
				}),
			}),
		)
	})

	it.each([true, false])("compacts Q with an active session=%s while Settings uses P", async (active) => {
		const { selection, stateManager, builder } = fixture()
		const config = await builder.build({ cwd: "/workspace", mode: "act", apiSelection: selection })
		const host = {
			readMessages: async () => [{ role: "user", content: "original" }],
			start: vi.fn(async () => ({ sessionId: "chat" })),
			stop: vi.fn(),
			dispose: vi.fn(),
			updateSessionCompactionState: vi.fn(),
		}
		const coordinator = new SdkCompactionCoordinator({
			stateManager,
			sessionConfigBuilder: builder,
			sessions: {
				getActiveSession: () =>
					active ? { sessionId: "chat", sdkHost: host, apiSnapshot: getSessionApiSnapshot(config) } : undefined,
				waitForPendingStop: vi.fn(),
			},
			rebuilds: { runExclusive: (run: () => Promise<void>) => run() },
			messages: { appendAndEmit: vi.fn() },
			taskHistory: {
				findHistoryItem: async () => ({ id: "chat", apiSelection: selection }),
				isLegacyTask: async () => false,
			},
			getDisplayedTaskId: () => "chat",
			createTempSessionHost: async () => host,
			loadInitialMessages: host.readMessages,
			getWorkspaceRoot: async () => "/workspace",
			postStateToWebview: vi.fn(),
		} as never)
		await coordinator.compactTask()
		expect(compactSessionMessages).toHaveBeenLastCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({
					providerId: "anthropic",
					modelId: "q-model",
				}),
			}),
		)
		if (!active)
			expect(host.start).toHaveBeenCalledWith(
				expect.objectContaining({ config: expect.objectContaining({ providerId: "anthropic" }) }),
			)
	})
})
