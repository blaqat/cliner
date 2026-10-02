import type { TaskApiSelection } from "@shared/api-profiles"
import { DeleteApiProfileRequest } from "@shared/proto/cline/models"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	type ApiProfileStore,
	deleteApiConfigProfile,
	ensureApiConfigProfiles,
	resolveApiConfigurationForTaskSelection,
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
			loadInitialMessages: expect.any(Function),
			disposeReason: "providerChange",
			onReplaced: expect.any(Function),
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

	describe("per-task pinned selections", () => {
		function makeProfileStore() {
			const state: Record<string, unknown> = {}
			const secrets: Record<string, string | undefined> = {}
			const legacy: Record<string, unknown> = {
				actModeApiProvider: "openai",
				openAiCompatibleApiType: "chat",
			}
			const store: ApiProfileStore = {
				getGlobalStateKey: ((key: string) => state[key]) as ApiProfileStore["getGlobalStateKey"],
				setGlobalStateBatch: (updates) => {
					Object.assign(state, updates)
					for (const [key, value] of Object.entries(updates)) {
						if (key.startsWith("planMode") || key.startsWith("actMode")) legacy[key] = value
					}
				},
				getApiConfiguration: () => snapshotApiProfileConfiguration(store, legacy as never, "act"),
				setApiConfiguration: (updates) => {
					Object.assign(legacy, updates)
				},
				getSecretForKey: (key) => secrets[key],
				setSecretsForKeys: (updates) => {
					Object.assign(secrets, updates)
				},
				listSecretStorageKeys: () => Object.keys(secrets),
			}
			return { store, state, secrets, legacy }
		}

		function attachStore(options: ReturnType<typeof makeCoordinator>["options"], store: ApiProfileStore) {
			for (const key of [
				"getGlobalStateKey",
				"setGlobalStateBatch",
				"getApiConfiguration",
				"setApiConfiguration",
				"getSecretForKey",
				"setSecretsForKeys",
				"listSecretStorageKeys",
			] as const) {
				;(options.stateManager as unknown as Record<string, unknown>)[key] = store[key]
			}
		}

		it.each([
			"model",
			"secret",
			"delete",
		])("reconciles a background profile %s against its build snapshot", async (change) => {
			const { store, state } = makeProfileStore()
			const p = upsertApiConfigProfile(store, {
				name: "P",
				provider: "openai",
				modelId: "p-model",
				secrets: { openAiApiKey: "old-key" },
			})
			const q = upsertApiConfigProfile(store, { name: "Q", provider: "openai", modelId: "q-model" })
			state.actProfileId = q.id
			const previous = store.getApiConfiguration()
			const selection = { actProfileId: p.id, actModeReasoningEffort: "low" as const }
			const a = {
				...makeActiveSession({ isRunning: true }),
				sessionId: "background",
				startConfig: { providerId: "openai", modelId: "p-model", mode: "act" as const },
				apiSnapshot: {
					selection,
					configuration: structuredClone(resolveApiConfigurationForTaskSelection(store, previous, "act", selection)),
				},
			}
			const { coordinator, options } = makeCoordinator({ activeSession: a })
			attachStore(options, store)
			const focused = {
				...makeActiveSession({ isRunning: true }),
				sessionId: "focused",
				startConfig: { providerId: "openai", modelId: "q-model", mode: "act" as const },
				apiSnapshot: {
					selection: { actProfileId: q.id },
					configuration: structuredClone(
						resolveApiConfigurationForTaskSelection(store, previous, "act", { actProfileId: q.id }),
					),
				},
			}
			options.sessions.getSessions = () =>
				new Map([
					[a.sessionId, a],
					[focused.sessionId, focused],
				]) as never
			options.getTaskApiSelection = (id) => (id === a.sessionId ? selection : focused.apiSnapshot.selection)
			if (change === "delete") deleteApiConfigProfile(store, p.id)
			else
				upsertApiConfigProfile(store, {
					...p,
					modelId: change === "model" ? "p-new" : p.modelId,
					secrets: change === "secret" ? { openAiApiKey: "new-key" } : undefined,
				})
			coordinator.handleApiConfigurationChanged(previous, store.getApiConfiguration())
			expect(options.rebuilds.request).toHaveBeenCalledExactlyOnceWith("provider", expect.any(Function), "background")
			expect(options.sessions.replaceActiveSession).not.toHaveBeenCalled()
			// Execute the deferred scheduler job after the background turn settles.
			a.isRunning = false
			const job = vi.mocked(options.rebuilds.request).mock.calls[0][1]
			await job({ isCurrent: () => true } as never)
			expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(
				expect.objectContaining({
					apiSelection: expect.objectContaining({ actProfileId: change === "delete" ? q.id : p.id }),
					apiConfiguration: expect.objectContaining(
						change === "secret"
							? { openAiApiKey: "new-key" }
							: { actModeOpenAiModelId: change === "delete" ? "q-model" : "p-new" },
					),
				}),
			)
		})

		it("changes effort only for the focused chat when two chats share a profile", () => {
			const { store, state, legacy } = makeProfileStore()
			const p = upsertApiConfigProfile(store, { name: "P", provider: "openai", modelId: "p-model" })
			state.actProfileId = p.id
			legacy.actModeReasoningEffort = "low"
			const previous = store.getApiConfiguration()
			const selection = { actProfileId: p.id, actModeReasoningEffort: "low" as const }
			const snapshot = {
				selection,
				configuration: structuredClone(resolveApiConfigurationForTaskSelection(store, previous, "act", selection)),
			}
			const a = {
				...makeActiveSession({ isRunning: true }),
				sessionId: "background",
				startConfig: { providerId: "openai", modelId: "p-model", mode: "act" as const },
				apiSnapshot: snapshot,
			}
			const b = { ...a, sessionId: "focused" }
			const { coordinator, options } = makeCoordinator({ activeSession: b })
			attachStore(options, store)
			options.sessions.getSessions = () =>
				new Map([
					[a.sessionId, a],
					[b.sessionId, b],
				]) as never
			options.getTaskApiSelection = (id) =>
				id === a.sessionId ? selection : { ...selection, actModeReasoningEffort: "high" }
			legacy.actModeReasoningEffort = "high"
			coordinator.handleApiConfigurationChanged(previous, store.getApiConfiguration())
			expect(options.rebuilds.request).toHaveBeenCalledExactlyOnceWith("provider", expect.any(Function), "focused")
		})

		it("does not restart a background session pinned to a different profile", () => {
			const { store, state } = makeProfileStore()
			const p = upsertApiConfigProfile(store, {
				name: "P",
				provider: "openai",
				modelId: "p-model",
				options: { openAiBaseUrl: "https://p/v1" },
			})
			const r = upsertApiConfigProfile(store, {
				name: "R",
				provider: "openai",
				modelId: "r-model",
				options: { openAiBaseUrl: "https://r/v1" },
			})
			const a = {
				...makeActiveSession(),
				sessionId: "a-session",
				startConfig: { providerId: "openai-compatible", modelId: "p-model", mode: "act" as const },
			}
			const b = {
				...makeActiveSession(),
				sessionId: "b-session",
				startConfig: { providerId: "openai-compatible", modelId: "p-model", mode: "act" as const },
			}
			const { coordinator, options } = makeCoordinator({ activeSession: b })
			options.sessions.getSessions = () =>
				new Map<string, typeof a | typeof b>([
					[a.sessionId, a],
					[b.sessionId, b],
				]) as never
			options.sessions.getSession = (id) =>
				new Map([
					[a.sessionId, a],
					[b.sessionId, b],
				]).get(id) as never
			options.sessions.replaceSession = options.sessions.replaceActiveSession
			attachStore(options, store)
			// Both chats were on P; the focused chat (b) just switched to R.
			const selections = new Map<string, TaskApiSelection>([
				["a-session", { actProfileId: p.id }],
				["b-session", { actProfileId: r.id }],
			])
			options.getTaskApiSelection = (id) => selections.get(id)

			state.actProfileId = p.id
			const previous = snapshotApiProfileConfiguration(store, {}, "act")
			state.actProfileId = r.id
			const next = snapshotApiProfileConfiguration(store, {}, "act")

			coordinator.handleApiConfigurationChanged(
				previous,
				next,
				new Map([
					["a-session", { actProfileId: p.id }],
					["b-session", { actProfileId: p.id }],
				]),
			)

			expect(options.rebuilds.request).toHaveBeenCalledExactlyOnceWith("provider", expect.any(Function), "b-session")
		})

		it("rebuilds a pinned session against its own profile, not the global selection", async () => {
			const { store, state, legacy } = makeProfileStore()
			const p = upsertApiConfigProfile(store, {
				name: "P",
				provider: "openai",
				modelId: "p-model",
				options: { openAiBaseUrl: "https://p-old/v1" },
				secrets: { openAiApiKey: "p-key" },
			})
			state.actProfileId = p.id
			const a = {
				...makeActiveSession(),
				sessionId: "a-session",
				startConfig: { providerId: "openai-compatible", modelId: "p-model", mode: "act" as const },
			}
			const { coordinator, options } = makeCoordinator({ activeSession: a })
			options.sessions.getSessions = () => new Map([[a.sessionId, a]]) as never
			options.sessions.getSession = (id) => (id === a.sessionId ? a : undefined) as never
			options.sessions.replaceSession = options.sessions.replaceActiveSession
			attachStore(options, store)
			options.getTaskApiSelection = () => ({ actProfileId: p.id })

			const previous = snapshotApiProfileConfiguration(store, legacy as never, "act")
			Object.assign(a, { apiSnapshot: { configuration: previous, selection: { actProfileId: p.id } } })
			// Edit the pinned profile's connection data in place.
			upsertApiConfigProfile(store, {
				...p,
				options: { openAiBaseUrl: "https://p-new/v1" },
			})
			const next = snapshotApiProfileConfiguration(store, legacy as never, "act")

			coordinator.handleApiConfigurationChanged(previous, next, new Map([["a-session", { actProfileId: p.id }]]))

			expect(options.rebuilds.request).toHaveBeenCalledWith("provider", expect.any(Function), "a-session")
			await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledOnce())
			const buildInput = options.sessionConfigBuilder.build.mock.calls.at(-1)?.[0] as {
				apiConfiguration?: Record<string, unknown>
			}
			expect(buildInput.apiConfiguration?.openAiBaseUrl).toBe("https://p-new/v1")
			expect(buildInput.apiConfiguration?.openAiApiKey).toBe("p-key")
		})
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
			replaceActiveSession: vi.fn(async (input) => {
				await input.loadInitialMessages?.()
				input.onReplaced?.("new-session")
				return { startResult: { sessionId: "new-session" }, sdkHost: { send: vi.fn() } }
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
