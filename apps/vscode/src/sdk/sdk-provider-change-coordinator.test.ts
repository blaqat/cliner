import { DeleteApiProfileRequest } from "@shared/proto/cline/models"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	type ApiProfileStore,
	ensureApiConfigProfiles,
	snapshotApiProfileConfiguration,
	upsertApiConfigProfile,
} from "@/core/controller/models/apiProfiles"
import { deleteApiProfile } from "@/core/controller/models/deleteApiProfile"
import type { StateManager } from "@/core/storage/StateManager"
import { buildSdkProviderConfig } from "./sdk-api-handler"
import { SdkProviderChangeCoordinator, type SdkProviderChangeCoordinatorOptions } from "./sdk-provider-change-coordinator"

vi.mock("./provider-migration", () => ({ getProviderSettingsManager: () => undefined }))

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		error: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
	},
}))

describe("SdkProviderChangeCoordinator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does nothing when the active mode provider did not change", () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		coordinator.handleApiConfigurationChanged(
			{ actModeApiProvider: "anthropic", planModeApiProvider: "openrouter" },
			{ actModeApiProvider: "anthropic", planModeApiProvider: "deepseek" },
		)

		expect(options.sessions.replaceActiveSession).not.toHaveBeenCalled()
	})

	it("does nothing when only the provider spelling changes", () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		// Stale snapshots can hold the SDK spelling (`openai-compatible`)
		// while new writes use the legacy spelling (`openai`); this is the
		// same provider, not a provider switch.
		coordinator.handleApiConfigurationChanged(
			{ actModeApiProvider: "openai-compatible" as never },
			{ actModeApiProvider: "openai" },
		)

		expect(options.sessions.replaceActiveSession).not.toHaveBeenCalled()
	})

	it("does nothing without an active session", () => {
		const { coordinator, options } = makeCoordinator()

		coordinator.handleApiConfigurationChanged({ actModeApiProvider: "anthropic" }, { actModeApiProvider: "deepseek" })

		expect(options.sessions.replaceActiveSession).not.toHaveBeenCalled()
	})

	it("restarts immediately when the active provider changes while idle", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		coordinator.handleApiConfigurationChanged({ actModeApiProvider: "anthropic" }, { actModeApiProvider: "deepseek" })

		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledOnce())
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({ cwd: "/workspace", mode: "act" })
		expect(options.loadInitialMessages).toHaveBeenCalledWith(activeSession.sdkHost, "old-session")
		expect(options.buildStartSessionInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-session" }), {
			cwd: "/workspace",
			mode: "act",
		})
		expect(options.sessions.replaceActiveSession).toHaveBeenCalledWith({
			expectedSession: activeSession,
			startInput: { prompt: "start" },
			initialMessages: [{ role: "user", content: "hello" }],
			disposeReason: "providerChange",
		})
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("uses the current plan mode when plan provider changes", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession, mode: "plan" })

		coordinator.handleApiConfigurationChanged(
			{ planModeApiProvider: "anthropic", actModeApiProvider: "deepseek" },
			{ planModeApiProvider: "openrouter", actModeApiProvider: "deepseek" },
		)

		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledOnce())
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({ cwd: "/workspace", mode: "plan" })
	})

	it("schedules the restart while the active session is running", () => {
		const activeSession = makeActiveSession({ isRunning: true })
		const { coordinator, options } = makeCoordinator({ activeSession })

		coordinator.handleApiConfigurationChanged({ actModeApiProvider: "anthropic" }, { actModeApiProvider: "deepseek" })

		expect(options.sessions.replaceActiveSession).not.toHaveBeenCalled()
		expect(options.rebuilds.request).toHaveBeenCalledWith("provider", expect.any(Function), "old-session")
	})

	it.each([
		{ actModeOpenAiModelId: "new-model" },
		{ openAiBaseUrl: "https://new-endpoint/v1" },
		{ openAiApiKey: "new-key" },
		{ openAiHeaders: { Authorization: "new-header" } },
		{ openAiCompatibleApiType: "responses" as const },
	])("rebuilds same-provider changes: %j", async (change) => {
		const { coordinator, options } = makeCoordinator({ activeSession: makeActiveSession() })
		const previous = { actModeApiProvider: "openai" as const, actModeOpenAiModelId: "old-model", openAiApiKey: "old-key" }
		coordinator.handleApiConfigurationChanged(previous, { ...previous, ...change })
		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledOnce())
	})

	it("schedules only background Ask sessions when their assigned profile changes", () => {
		const ask = {
			...makeActiveSession({ isRunning: true }),
			sessionId: "ask-session",
			startConfig: { providerId: "openai-compatible", modelId: "ask", mode: "plan" as const },
		}
		const act = {
			...makeActiveSession({ isRunning: true }),
			startConfig: { providerId: "openai-compatible", modelId: "act", mode: "act" as const },
		}
		const { coordinator, options } = makeCoordinator({ activeSession: act })
		options.sessions.getSessions = () =>
			new Map<string, typeof ask | typeof act>([
				[ask.sessionId, ask],
				[act.sessionId, act],
			]) as never
		const profiles = [
			{ id: "a", name: "A", provider: "openai", modelId: "ask", options: { openAiBaseUrl: "https://old-a/v1" } },
			{ id: "b", name: "B", provider: "openai", modelId: "act", options: { openAiBaseUrl: "https://b/v1" } },
		]
		const state = { apiConfigProfiles: profiles, askProfileId: "a", actProfileId: "b" }
		const store = {
			getGlobalStateKey: (key: keyof typeof state) => state[key],
			listSecretStorageKeys: () => [],
			getSecretForKey: () => undefined,
		} as unknown as ApiProfileStore
		const before = snapshotApiProfileConfiguration(store, {}, "act")
		profiles[0] = { ...profiles[0], options: { openAiBaseUrl: "https://new-a/v1" } }
		const after = snapshotApiProfileConfiguration(store, {}, "act")
		coordinator.handleApiConfigurationChanged(before, after)
		expect(options.rebuilds.request).toHaveBeenCalledExactlyOnceWith("provider", expect.any(Function), "ask-session")
	})

	it.each([
		"assigned",
		"unassigned",
	])("deleting an %s profile compares finalized assignments for focused and background sessions", async (assignment) => {
		const ask = { ...makeActiveSession(), sessionId: "ask-session", startConfig: { mode: "plan" as const } }
		const act = { ...makeActiveSession(), sessionId: "act-session", startConfig: { mode: "act" as const } }
		const { coordinator, options } = makeCoordinator({ activeSession: act })
		const sessions = new Map<string, typeof ask | typeof act>([
			[ask.sessionId, ask],
			[act.sessionId, act],
		])
		options.sessions.getSessions = () => sessions as never
		options.sessions.getSession = (id) => sessions.get(id) as never
		options.sessions.replaceSession = options.sessions.replaceActiveSession
		const state: Record<string, unknown> = {}
		const secrets: Record<string, string | undefined> = {}
		const legacy = {
			planModeApiProvider: "openai" as const,
			actModeApiProvider: "openai" as const,
			planModeOpenAiModelId: "A",
			actModeOpenAiModelId: "A",
			openAiBaseUrl: "https://A",
			openAiApiKey: "a-key",
			openAiCompatibleApiType: "chat" as const,
		}
		const store: ApiProfileStore = {
			getGlobalStateKey: ((key: string) => state[key]) as ApiProfileStore["getGlobalStateKey"],
			setGlobalStateBatch: (updates) => {
				Object.assign(state, updates)
			},
			getApiConfiguration: () => snapshotApiProfileConfiguration(store, legacy, "act"),
			setApiConfiguration: (updates) => {
				Object.assign(legacy, updates)
			},
			getSecretForKey: (key) => secrets[key],
			setSecretsForKeys: (updates) => {
				Object.assign(secrets, updates)
			},
			listSecretStorageKeys: () => Object.keys(secrets),
		}
		const migrated = ensureApiConfigProfiles(store).profiles[0]
		const b = upsertApiConfigProfile(store, {
			name: "B",
			provider: "openai",
			modelId: "B",
			options: { openAiBaseUrl: "https://b/v1" },
			secrets: { openAiApiKey: "b-key" },
		})
		const builtProviders: unknown[] = []
		options.sessionConfigBuilder.build.mockImplementation(async ({ mode }) => {
			builtProviders.push(buildSdkProviderConfig(store.getApiConfiguration(), mode))
			return { providerId: "openai-compatible", modelId: "B" }
		})
		const postState = vi.fn(async () => {
			expect(state.askProfileId).toBe(assignment === "assigned" ? b.id : migrated.id)
			expect(state.actProfileId).toBe(state.askProfileId)
		})
		await deleteApiProfile(
			{
				stateManager: store,
				handleApiConfigurationChanged: coordinator.handleApiConfigurationChanged.bind(coordinator),
				postStateToWebview: postState,
			} as never,
			DeleteApiProfileRequest.create({ id: assignment === "assigned" ? migrated.id : b.id }),
		)
		if (assignment === "unassigned") {
			expect(options.rebuilds.request).not.toHaveBeenCalled()
			expect(options.sessionConfigBuilder.build).not.toHaveBeenCalled()
		} else {
			await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledTimes(2))
			expect(options.rebuilds.request).toHaveBeenCalledWith("provider", expect.any(Function), ask.sessionId)
			expect(options.rebuilds.request).toHaveBeenCalledWith("provider", expect.any(Function), act.sessionId)
			expect(builtProviders).toEqual([
				expect.objectContaining({ modelId: "B", baseUrl: "https://b/v1", apiKey: "b-key" }),
				expect.objectContaining({ modelId: "B", baseUrl: "https://b/v1", apiKey: "b-key" }),
			])
			expect(secrets[`profile:${migrated.id}:openAiApiKey`]).toBeUndefined()
		}
		expect(postState).toHaveBeenCalledOnce()
	})

	it("updates the task id when the replacement session id changes", async () => {
		const activeSession = makeActiveSession()
		const task = { taskId: "old-session" }
		const { coordinator, options } = makeCoordinator({ activeSession, task })

		await coordinator.restartActiveSessionForProviderChange()

		expect(task.taskId).toBe("new-session")
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("runs a follow-up restart when another provider change lands during restart", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })
		let resolveFirstRestart: (() => void) | undefined
		options.sessions.replaceActiveSession.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveFirstRestart = () => {
					resolve({
						startResult: { sessionId: "new-session" },
						sdkHost: { send: vi.fn() },
					})
				}
			}),
		)

		const firstRestart = coordinator.restartActiveSessionForProviderChange()
		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledOnce())

		const secondRestart = coordinator.restartActiveSessionForProviderChange()
		resolveFirstRestart?.()
		await firstRestart
		await secondRestart

		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledTimes(2))
	})

	it("emits an error message when restart fails", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })
		options.sessions.replaceActiveSession.mockRejectedValue(new Error("boom"))

		await coordinator.restartActiveSessionForProviderChange()

		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					type: "say",
					say: "error",
					text: "Failed to reload provider configuration: boom. The active session may still use the previous provider.",
				}),
			],
			{ type: "status", payload: { sessionId: "old-session", status: "error" } },
		)
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})
})

function makeCoordinator(input: Partial<MakeCoordinatorInput> = {}) {
	const activeSession = input.activeSession
	const config = {
		providerId: "deepseek",
		modelId: "deepseek-v4-flash",
		apiKey: "key",
	}
	const options = {
		stateManager: {
			getGlobalSettingsKey: vi.fn(() => input.mode ?? "act"),
		} as unknown as StateManager,
		sessions: {
			getActiveSession: vi.fn(() => activeSession),
			replaceActiveSession: vi.fn().mockResolvedValue({
				startResult: { sessionId: "new-session" },
				sdkHost: { send: vi.fn() },
			}),
		},
		messages: {
			appendAndEmit: vi.fn(),
		},
		sessionConfigBuilder: {
			build: vi.fn().mockResolvedValue(config),
		},
		getTask: vi.fn(() => input.task),
		getWorkspaceRoot: vi.fn().mockResolvedValue("/workspace"),
		loadInitialMessages: vi.fn().mockResolvedValue([{ role: "user", content: "hello" }]),
		buildStartSessionInput: vi.fn(() => ({ prompt: "start" })),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		rebuilds: {
			cancel: vi.fn(),
			request: vi.fn((_reason: string, rebuild: () => Promise<void>) => {
				if (!activeSession?.isRunning) {
					void (rebuild as unknown as (context: { isCurrent: () => boolean }) => Promise<void>)({
						isCurrent: () => true,
					})
				}
			}),
		},
	} as unknown as SdkProviderChangeCoordinatorOptions & {
		stateManager: StateManager & { getGlobalSettingsKey: ReturnType<typeof vi.fn> }
		sessions: SdkProviderChangeCoordinatorOptions["sessions"] & {
			getActiveSession: ReturnType<typeof vi.fn>
			replaceActiveSession: ReturnType<typeof vi.fn>
		}
		messages: SdkProviderChangeCoordinatorOptions["messages"] & { appendAndEmit: ReturnType<typeof vi.fn> }
		sessionConfigBuilder: SdkProviderChangeCoordinatorOptions["sessionConfigBuilder"] & {
			build: ReturnType<typeof vi.fn>
		}
		getTask: ReturnType<typeof vi.fn>
		getWorkspaceRoot: ReturnType<typeof vi.fn>
		loadInitialMessages: ReturnType<typeof vi.fn>
		buildStartSessionInput: ReturnType<typeof vi.fn>
		postStateToWebview: ReturnType<typeof vi.fn>
	}

	return {
		coordinator: new SdkProviderChangeCoordinator(options),
		options,
	}
}

interface MakeCoordinatorInput {
	activeSession: ReturnType<typeof makeActiveSession>
	mode: "act" | "plan"
	task: { taskId: string }
}

function makeActiveSession(input: { isRunning?: boolean } = {}) {
	return {
		sessionId: "old-session",
		sdkHost: {
			send: vi.fn(),
			stop: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		},
		unsubscribe: vi.fn(),
		startResult: { sessionId: "old-session" },
		isRunning: input.isRunning ?? false,
	}
}
