import type { TaskApiSelection } from "@shared/api-profiles"
import type { ModelSettings } from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { mutateSettings } from "@/core/controller/models/modelSettingsRpc"
import { focusedModelsFromSnapshot } from "@/core/controller/models/taskApiModel"
import { getSessionApiSnapshot } from "./cline-session-factory"
import { InMemoryConnectionSecretStore } from "./model-settings/connection-secret-store"
import { ModelPickUnavailableError, NextMessageModelSelections } from "./model-settings-resolver"
import { SdkMcpCoordinator } from "./sdk-mcp-coordinator"
import { SdkModeCoordinator } from "./sdk-mode-coordinator"
import { SdkProviderChangeCoordinator } from "./sdk-provider-change-coordinator"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import { SdkSessionConfigChangeCoordinator } from "./sdk-session-config-change-coordinator"
import { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"
import { prepareTaskResumeStartInput } from "./sdk-task-resume"
import { SdkTaskStartCoordinator } from "./sdk-task-start-coordinator"

vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("./model-settings/rollout", () => ({ modelSettingsRolloutEnabled: () => true }))
vi.mock("./sdk-api-handler", () => ({ buildSdkProviderConfig: vi.fn() }))
vi.mock("./hooks-adapter", () => ({ buildAgentHooks: () => ({}) }))
vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: () => {
		throw new Error("No SDK account access")
	},
}))
vi.mock("./cline-session-factory", () => ({
	buildSessionConfig: async (input: { configuredProvider: { providerId: string; modelId: string } }) => ({
		providerId: input.configuredProvider.providerId,
		modelId: input.configuredProvider.modelId,
		providerConfig: input.configuredProvider,
	}),
	getSessionApiSnapshot: (config: { apiSnapshot?: unknown }) => config.apiSnapshot,
}))

const act = { modelId: "act", levelId: "default" }
const ask = { modelId: "ask", levelId: "default" }
const stable = { version: 1 as const, ask, act }

function fixture() {
	const settings: ModelSettings = {
		version: 1,
		revision: 1,
		requestTimeoutMs: null,
		connections: [
			{
				id: "connection",
				name: "Local",
				kind: "openai-compatible",
				baseUrl: "https://example.invalid/v1",
				apiFormat: "chat",
				azureApiVersion: null,
				auth: { kind: "none" },
				headers: [],
				defaults: {},
				requestTimeoutMs: null,
			},
		],
		models: ["act", "ask", "new-default"].map((id) => ({
			id,
			connectionId: "connection",
			upstreamId: id,
			name: id,
			kind: "chat",
			overrides: {},
			providerOptions: {},
		})),
		roles: {
			chat: { modelId: "new-default", levelId: "default" },
			ask: { enabled: true, pick: ask },
			subagents: { kind: "thread", level: "inherit" },
			background: { pick: null, titlesEnabled: false, overrides: {} },
		},
		subagents: {
			enabled: true,
			maxConcurrent: 3,
			access: { write: true, commands: true, web: true, mcp: true },
			blocking: "parent-decides",
			allowed: [],
		},
	}
	const legacy: TaskApiSelection = { askProfileId: "old-ask", actProfileId: "old-act" }
	let mode = "act"
	const managed: Record<string, unknown> = {}
	const state = {
		connectionSecrets: new InMemoryConnectionSecretStore(),
		getGlobalStateKey: (key: string): unknown =>
			(
				({
					modelSettings: settings,
					modelSettingsMigration: {
						version: 1,
						status: "complete",
						configurationModels: {},
						profilePicks: { "old-ask": ask, "old-act": act },
					},
				}) as Record<string, unknown>
			)[key],
		getGlobalSettingsKey: () => mode,
		setGlobalState: (_key: string, value: string) => {
			mode = value
		},
		getApiConfiguration: () => ({}),
		getRemoteConfigSettings: () => managed,
	}
	const builder = new SdkSessionConfigBuilder({ stateManager: state as never, emitHookMessage: vi.fn() })
	const session = {
		sessionId: "thread",
		sdkHost: {},
		isRunning: false,
		queuedPromptCount: 0,
		startConfig: { mode: "act" },
		apiSnapshot: { selection: legacy, configuration: {} },
	}
	const committed = vi.fn()
	let scheduled: (() => Promise<void>) | undefined
	const replace = vi.fn(async (input) => {
		await input.loadInitialMessages()
		await input.onReplaced?.("thread")
		return { sdkHost: {}, startResult: { sessionId: "thread" } }
	})
	const options = {
		stateManager: state,
		sessionConfigBuilder: builder,
		sessions: {
			getActiveSession: () => session,
			getSession: () => session,
			replaceActiveSession: replace,
			replaceSession: replace,
			setStatus: vi.fn(),
		},
		messages: { emitSessionEvents: vi.fn(), appendAndEmit: vi.fn() },
		getWorkspaceRoot: async () => "/fixture",
		loadInitialMessages: async () => [],
		buildStartSessionInput: (config: unknown) => ({ config }),
		getTaskApiSelection: () => legacy,
		getTask: () => ({ taskId: "thread" }),
		onSelectionRebuilt: committed,
		onModeRebuilt: (_id: string, _mode: string, selection: unknown) => committed("thread", selection),
		resetMessageTranslator: vi.fn(),
		postStateToWebview: async () => {},
		emitClineAuthError: vi.fn(),
		rebuilds: {
			request: (_reason: string, run: (context: unknown) => Promise<void>) => {
				scheduled = () => run({ isCurrent: () => true })
			},
			runExclusive: (run: () => Promise<unknown>) => run(),
		},
	}
	return {
		settings,
		legacy,
		state,
		builder,
		session,
		committed,
		replace,
		options,
		drain: async () => {
			await scheduled?.()
		},
	}
}

describe("configured selections at coordinator boundaries (rollout explicitly enabled)", () => {
	it.each([
		"checkpoints",
		"subagents",
		"terminal",
		"taskGroup",
		"mcp",
		"provider",
		"mode",
	])("persists the converted built snapshot at the %s boundary", async (reason) => {
		const f = fixture()
		if (reason === "provider") {
			await new SdkProviderChangeCoordinator(f.options as never).restartActiveSessionForProviderChange()
		} else if (reason === "mode") {
			await new SdkModeCoordinator(f.options as never).rebuildSessionForMode("plan")
		} else if (reason === "mcp") {
			await new SdkMcpCoordinator(f.options as never).restartSessionForMcpTools()
		} else {
			const coordinator = new SdkSessionConfigChangeCoordinator(f.options as never)
			if (reason === "checkpoints") coordinator.handleCheckpointsSettingChanged(false, true)
			if (reason === "subagents") coordinator.handleSubagentSettingsChanged()
			if (reason === "terminal") coordinator.handleTerminalExecutionModeChanged("backgroundExec", "vscodeTerminal")
			if (reason === "taskGroup") coordinator.handleTaskGroupChanged("thread")
			await f.drain()
		}
		expect(f.replace).toHaveBeenCalledOnce()
		expect(f.committed).toHaveBeenCalledOnce()
		expect(f.committed.mock.calls[0][1].modelSelectionV1).toEqual(stable)
		expect(f.legacy).not.toHaveProperty("modelSelectionV1")
		const config = f.replace.mock.calls[0][0].startInput.config
		expect(config.modelId).toBe(reason === "mode" ? "ask" : "act")
	})

	it.each(["mcp", "provider", "mode", "checkpoints"])("does not persist a refused %s replacement", async (reason) => {
		const f = fixture()
		f.replace.mockResolvedValueOnce(undefined as never)
		if (reason === "provider")
			await new SdkProviderChangeCoordinator(f.options as never).restartActiveSessionForProviderChange()
		if (reason === "mode") await new SdkModeCoordinator(f.options as never).rebuildSessionForMode("plan")
		if (reason === "mcp") await new SdkMcpCoordinator(f.options as never).restartSessionForMcpTools()
		if (reason === "checkpoints") {
			new SdkSessionConfigChangeCoordinator(f.options as never).handleCheckpointsSettingChanged(false, true)
			await f.drain()
		}
		expect(f.committed).not.toHaveBeenCalled()
	})

	it("keeps exact picks across resume/compaction preparation and refuses a removed model or level", async () => {
		const f = fixture()
		const historyItem = { id: "thread", ts: 1, task: "fixture", modelSelectionV1: stable }
		const deps = {
			stateManager: f.state,
			sessionConfigBuilder: f.builder,
			taskHistory: { findHistoryItem: async () => historyItem, isLegacyTask: async () => false },
			getWorkspaceRoot: async () => "/fixture",
			createTempSessionHost: async () => ({ dispose: async () => {} }),
			loadInitialMessages: async () => [{ role: "user", content: "saved" }],
		}
		const first = await prepareTaskResumeStartInput(deps as never, "thread")
		expect(first.sessionMetadata?.modelSelectionV1).toEqual(stable)
		expect(first.config.modelId).toBe("act")
		f.settings.roles.chat = null
		expect((await prepareTaskResumeStartInput(deps as never, "thread")).sessionMetadata?.modelSelectionV1).toEqual(stable)
		f.settings.models = f.settings.models.filter((model) => model.id !== act.modelId)
		await expect(prepareTaskResumeStartInput(deps as never, "thread")).rejects.toThrow(/No model selected/)
		f.settings.models.push({
			id: "act",
			connectionId: "connection",
			upstreamId: "act",
			name: "",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		})
		historyItem.modelSelectionV1 = { ...stable, act: { ...act, levelId: "removed" } }
		await expect(prepareTaskResumeStartInput(deps as never, "thread")).rejects.toThrow(/level.*Settings > Models/i)
	})
})

it("passes configured subagent allowlist, cap, blocking and access through the session builder", async () => {
	const f = fixture()
	const settings = f.state.getGlobalStateKey("modelSettings") as ModelSettings
	settings.roles.subagents = { kind: "model", pick: ask }
	settings.subagents = {
		enabled: true,
		maxConcurrent: 2,
		blocking: "always",
		access: { write: false, commands: false, web: true, mcp: false },
		allowed: [
			{ kind: "model", modelId: "act", levels: ["default"] },
			{ kind: "thread", levels: ["inherit"] },
		],
	}
	const builder = new SdkSessionConfigBuilder({ stateManager: f.state as never, emitHookMessage: vi.fn() })
	const config = await builder.build({ cwd: "/tmp", mode: "act", apiSelection: { modelSelectionV1: stable } } as never)
	expect(config.enableSpawnAgent).toBe(true)
	expect(config.subagentSettings).toMatchObject({
		maxConcurrent: 2,
		allowWrite: false,
		allowCommands: false,
		allowWeb: true,
		allowMcp: false,
		modelPolicy: {
			version: 1,
			default: { model: "ask", level: "default" },
			blocking: "always",
			allowed: [
				{ model: "act", levels: ["default"] },
				{ model: "parent", levels: ["inherit"] },
			],
			models: {
				ask: { id: "ask", connection: { modelId: "ask", providerId: "openai-compatible" } },
				act: { id: "act", connection: { modelId: "act", providerId: "openai-compatible" } },
			},
		},
	})
})

describe("transient configured runtime selections", () => {
	it("keeps durable snapshots and isolates threads and modes", async () => {
		const f = fixture()
		const next = new NextMessageModelSelections()
		next.set("first", "act", ask)
		const builder = new SdkSessionConfigBuilder({
			stateManager: f.state as never,
			emitHookMessage: vi.fn(),
			nextMessageSelections: next,
		})
		const input = { cwd: "/tmp", mode: "act", apiSelection: { modelSelectionV1: stable } } as const
		const first = await builder.build(input as never, "first")
		const other = await builder.build(input as never, "other")
		const plan = await builder.build({ ...input, mode: "plan" } as never, "first")
		expect(first.modelId).toBe("ask")
		expect(other.modelId).toBe("act")
		expect(plan.modelId).toBe("ask")
		expect(getSessionApiSnapshot(first)?.selection.modelSelectionV1).toEqual(stable)
		builder.admission(first)?.()
		expect(next.peek("first", "act")).toBeUndefined()
		expect((await builder.build(input as never, "first")).modelId).toBe("act")
	})
	it("does not let an old admission consume a newer pick, including after draft transfer", () => {
		const next = new NextMessageModelSelections()
		next.set("", "act", ask)
		const admission = next.admission("", "act")!
		next.move("", "first")
		next.set("first", "act", act)
		admission.commit()
		expect(next.peek("first", "act")).toEqual(act)
		expect(next.peek("other", "act")).toBeUndefined()
	})
})

// These tests cross the controller, builder and lifecycle admission boundary.
// Hosts and secrets are memory-only; no user directories or keychain are used.
describe("next-message admission integration", () => {
	async function harness(draft = false) {
		const f = fixture()
		const next = new NextMessageModelSelections()
		const builder = new SdkSessionConfigBuilder({
			stateManager: f.state as never,
			emitHookMessage: vi.fn(),
			nextMessageSelections: next,
		})
		const { Controller } = await import("./SdkController")
		const controller = Object.create(Controller.prototype) as InstanceType<typeof Controller>
		const sessions = new Map<
			string,
			{ startConfig: object; isRunning: boolean; queuedPromptCount: number; sessionId: string; sdkHost: object }
		>()
		const deferred = new Map()
		const rebuild = vi.fn()
		Object.defineProperty(controller, "task", { value: draft ? undefined : { taskId: "first" }, writable: true })
		Object.assign(controller, {
			stateManager: f.state,
			configuredNextMessageSelections: next,
			configuredDeferredSends: deferred,
			admittedConfiguredRuntimes: new WeakSet(),
			taskSessions: new Map(),
			sessions: { getSession: (id: string) => sessions.get(id), fireAndForgetSend: vi.fn() },
			sessionConfigBuilder: builder,
			providerChanges: { handleApiConfigurationChanged: rebuild },
			sessionRebuilds: { runExclusive: async (run: () => Promise<void>) => run() },
			postStateToWebview: async () => {},
		})
		const build = async (id: string, mode: "plan" | "act" = "act", source = id) => {
			const config = await builder.build({ cwd: "/tmp", mode, apiSelection: { modelSelectionV1: stable } } as never, source)
			sessions.set(id, { sessionId: id, sdkHost: {}, startConfig: config, isRunning: false, queuedPromptCount: 0 })
			return config
		}
		const arm = (id: string, mode: "plan" | "act" = "act") =>
			controller.setConfiguredThreadSelection({
				taskId: id,
				mode,
				pick: { modelId: "new-default", levelId: "default" },
				nextMessageOnly: true,
			})
		return { ...f, next, builder, controller, sessions, deferred, rebuild, build, arm }
	}

	it.each([false, true])("transfers a home pick through task start, including failed start=%s", async (failStart) => {
		const h = await harness(true)
		await h.arm("")
		let startedConfig: object | undefined
		let realId = ""
		const start = new SdkTaskStartCoordinator({
			stateManager: h.state,
			sessionConfigBuilder: h.builder,
			getWorkspaceRoot: async () => "/tmp",
			clearTask: async () => {},
			setTask: () => {},
			consumeDraftApiSelection: () => ({ modelSelectionV1: stable }),
			buildStartSessionInput: (config: object) => ({ config }),
			transferDraftModelPick: (id: string) => h.next.move("", id),
			messages: { appendAndEmit: vi.fn(), emitHookMessage: vi.fn() },
			taskHistory: { updateTaskHistoryItem: async () => {} },
			createHistoryItemFromSession: (id: string) => ({ id }),
			resolveContextMentions: async (text: string) => text,
			postStateToWebview: async () => {},
			sessions: {
				startNewSession: async ({ config }: { config: { sessionId: string } }) => {
					startedConfig = config
					realId = config.sessionId
					if (failStart) throw new Error("start rejected")
					h.sessions.set(config.sessionId, {
						sessionId: config.sessionId,
						sdkHost: {},
						startConfig: config,
						isRunning: false,
						queuedPromptCount: 0,
					})
					return { sdkHost: {}, startResult: { sessionId: config.sessionId } }
				},
				fireAndForgetSend: (_host: object, id: string) => h.controller["configuredModelAdmission"](id)!(),
			},
		} as never)
		const id = await start.initTask("hello")
		if (failStart) {
			expect(id).toBeUndefined()
			expect(h.next.peek(realId, "act")?.modelId).toBe("new-default")
			expect((await h.build(realId)).modelId).toBe("new-default")
			h.controller["configuredModelAdmission"](realId)!()
			expect(h.next.peek(realId, "act")).toBeUndefined()
			return
		}
		expect(id).toEqual(expect.any(String))
		expect(startedConfig).toHaveProperty("modelId", "new-default")
		expect(getSessionApiSnapshot(startedConfig)?.selection.modelSelectionV1).toEqual(stable)
		expect(h.next.peek(id!, "act")).toBeUndefined()
		expect((await h.build(id!)).modelId).toBe("act")
	})

	it("holds a queued message during the temporary turn and flushes after durable rebuild", async () => {
		const h = await harness()
		await h.arm("first")
		await h.build("first")
		h.controller["configuredModelAdmission"]("first")!()
		h.sessions.get("first")!.isRunning = true
		expect(h.controller["deferOneTurnFollowup"]("first", "queued", undefined, undefined, "queue")).toBe(true)
		expect(h.deferred.get("first")).toEqual([{ prompt: "queued", images: undefined, files: undefined }])
		await h.build("first")
		h.controller["commitTaskApiSelection"]("first", { modelSelectionV1: stable })
		expect(h.deferred.has("first")).toBe(false)
	})

	it("retains a cancelled pre-admission pick across a retry rebuild", async () => {
		const h = await harness()
		await h.arm("first")
		await h.build("first")
		const cancel = vi.fn(async () => {})
		Object.assign(h.controller, { turnStateTracker: { set: vi.fn() }, taskControl: { cancelTask: cancel } })
		h.deferred.set("first", [{ prompt: "cancelled follow-up" }])
		await h.controller.cancelTask()
		expect(cancel).toHaveBeenCalledOnce()
		expect(h.deferred.has("first")).toBe(false)
		expect((await h.build("first")).modelId).toBe("new-default")
		expect(h.next.peek("first", "act")?.modelId).toBe("new-default")
	})

	it("waits for an in-flight rebuild when arming races with sending", async () => {
		const h = await harness()
		await h.build("first")
		const read = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const getSession = () => h.sessions.get("first")
		const scheduler = new SdkSessionRebuildScheduler({ sessions: { getActiveSession: getSession } as never })
		const options = {
			...h.options,
			sessionConfigBuilder: h.builder,
			sessions: {
				getActiveSession: getSession,
				getSession,
				replaceSession: async (input: {
					startInput: { config: object }
					loadInitialMessages: () => Promise<unknown>
					onReplaced: () => void
				}) => {
					await input.loadInitialMessages()
					h.sessions.set("first", {
						sessionId: "first",
						sdkHost: {},
						startConfig: input.startInput.config,
						isRunning: false,
						queuedPromptCount: 0,
					})
					input.onReplaced()
					return { sdkHost: {}, startResult: { sessionId: "first" } }
				},
			},
			rebuilds: scheduler,
			loadInitialMessages: async () => {
				read.resolve()
				await release.promise
				return []
			},
		}
		Object.assign(h.controller, {
			sessionRebuilds: scheduler,
			providerChanges: new SdkProviderChangeCoordinator(options as never),
		})
		scheduler.request("mcpTools", () => new SdkMcpCoordinator(options as never).restartSessionForMcpTools())
		await read.promise
		let armed = false
		const arming = h.arm("first").then(() => {
			armed = true
		})
		await Promise.resolve()
		expect(armed).toBe(false)
		release.resolve()
		await arming
		const config = h.sessions.get("first")!.startConfig
		expect(config).toHaveProperty("modelId", "new-default")
		h.controller["configuredModelAdmission"]("first")!()
		expect(h.next.peek("first", "act")).toBeUndefined()
		expect((await h.build("first")).modelId).toBe("act")
	})

	it("consumes only the admitted thread's pick", async () => {
		const h = await harness()
		await h.arm("first")
		h.next.set("second", "act", ask)
		await h.build("first")
		await h.build("second")
		h.controller["configuredModelAdmission"]("first")!()
		expect(h.next.peek("first", "act")).toBeUndefined()
		expect(h.next.peek("second", "act")).toEqual(ask)
	})

	it("switches modes without using or consuming the other mode's pick", async () => {
		const h = await harness()
		await h.arm("first")
		h.options.sessionConfigBuilder = h.builder
		h.options.sessions.getActiveSession = () => ({ ...h.session, sessionId: "first" })
		h.options.sessions.getSession = h.options.sessions.getActiveSession
		await new SdkModeCoordinator(h.options as never).rebuildSessionForMode("plan")
		const config = h.replace.mock.calls.at(-1)![0].startInput.config
		expect(config.modelId).toBe("ask")
		expect(h.builder.admission(config)).toBeUndefined()
		expect(h.next.peek("first", "act")?.modelId).toBe("new-default")
	})

	it("uses a pick only for a message resume, leaving compaction on durable selection", async () => {
		const h = await harness()
		h.next.set("thread", "act", { modelId: "new-default", levelId: "default" })
		const deps = {
			stateManager: h.state,
			sessionConfigBuilder: h.builder,
			taskHistory: {
				findHistoryItem: async () => ({ apiSelection: { modelSelectionV1: stable } }),
				isLegacyTask: async () => false,
			},
			getWorkspaceRoot: async () => "/tmp",
			createTempSessionHost: async () => ({ dispose: async () => {} }),
			loadInitialMessages: async () => [],
		}
		const compact = await prepareTaskResumeStartInput(deps as never, "thread")
		const message = await prepareTaskResumeStartInput(deps as never, "thread", true)
		expect(compact.config.modelId).toBe("act")
		expect(message.config.modelId).toBe("new-default")
		expect(getSessionApiSnapshot(message.config)?.selection.modelSelectionV1).toEqual(stable)
		h.builder.admission(message.config)!()
		expect((await prepareTaskResumeStartInput(deps as never, "thread", true)).config.modelId).toBe("act")
	})
})

// All admissions share the runtime builder; policy is also checked after construction.
it.each([
	"send",
	"resume",
	"mode-switch",
	"background-text",
	"subagent",
] as const)("rechecks current policy at %s admission", async (path) => {
	const f = fixture()
	const state = f.state as never
	const settings = f.state.getGlobalStateKey("modelSettings") as ModelSettings
	const managed = f.state.getRemoteConfigSettings() as Record<string, unknown>
	const mode = path === "mode-switch" ? "plan" : "act"
	settings.roles.background.pick = act
	settings.roles.background.titlesEnabled = true
	settings.roles.subagents = { kind: "model", pick: ask }
	const builder = new SdkSessionConfigBuilder({ stateManager: state, emitHookMessage: vi.fn() })
	const config = await builder.build({ cwd: "/tmp", mode, apiSelection: { modelSelectionV1: stable } } as never)
	managed.remoteConfiguredProviders = ["anthropic"]
	if (path === "background-text") {
		const { backgroundHandler } = await import("./model-settings/background")
		await expect(backgroundHandler(state, "generate")).rejects.toThrow(/organization/)
	} else if (path === "subagent") {
		await expect(config.hooks!.beforeTool!({ toolCall: { toolName: "spawn_agent" } } as never)).rejects.toThrow(
			/organization/,
		)
	} else {
		await expect(config.hooks!.beforeModel!({} as never)).rejects.toThrow(/organization/)
	}
})

describe("a thread's pick for a mode", () => {
	const build = (f: ReturnType<typeof fixture>, thread: object) =>
		new SdkSessionConfigBuilder({ stateManager: f.state as never, emitHookMessage: vi.fn() }).build({
			cwd: "/tmp",
			mode: "plan",
			apiSelection: { modelSelectionV1: { version: 1, act, ...thread } },
		} as never)

	const gone = { modelId: "gone", levelId: "default" }

	it.each([
		["has none", null],
		["names a removed model", gone],
	])("runs on the default when it %s, so setting one in Settings reaches it", async (_name, pick) => {
		const f = fixture()
		const settings = f.state.getGlobalStateKey("modelSettings") as ModelSettings
		expect((await build(f, { ask: pick })).modelId).toBe("ask")
		settings.roles.ask = { enabled: false, pick: null }
		expect((await build(f, { ask: pick })).modelId).toBe("new-default")
	})

	it("keeps naming the removed model, so a later default still reaches it", async () => {
		const f = fixture()
		const config = await build(f, { ask: gone })
		expect(getSessionApiSnapshot(config)?.selection.modelSelectionV1).toMatchObject({ ask: gone })
		expect(getSessionApiSnapshot(config)?.configuredModel).toMatchObject({ modelId: "ask" })
	})

	it.each([
		["has none", null],
		["names a removed model", gone],
	])("with no default either, one that %s says it can't run, in the error a mode switch carries on past", async (_name, pick) => {
		const f = fixture()
		const settings = f.state.getGlobalStateKey("modelSettings") as ModelSettings
		settings.roles.chat = null
		settings.roles.ask = { enabled: false, pick: null }
		const refused = build(f, { ask: pick })
		await expect(refused).rejects.toBeInstanceOf(ModelPickUnavailableError)
		await expect(refused).rejects.toThrow(/No model selected/)
	})
})

it("uses managed remote model values and refuses an obsolete projection in a live session", async () => {
	const f = fixture()
	const managed = f.state.getRemoteConfigSettings() as Record<string, unknown>
	managed.remoteProviderSettings = { OpenAiCompatible: { models: [{ id: "act", contextWindow: 42000, maxTokens: 1000 }] } }
	const builder = new SdkSessionConfigBuilder({ stateManager: f.state as never, emitHookMessage: vi.fn() })
	const config = await builder.build({ cwd: "/tmp", mode: "act", apiSelection: { modelSelectionV1: stable } } as never)
	expect(config.providerConfig?.maxOutputTokens).toBe(1000)
	expect(config.providerConfig?.knownModels?.act.contextWindow).toBe(42000)
	managed.remoteProviderSettings = { OpenAiCompatible: { models: [{ id: "act", contextWindow: 32000 }] } }
	await expect(config.hooks!.beforeModel!({} as never)).rejects.toThrow(/changed this model.s settings/i)
})

describe("editing settings under a live session", () => {
	/** The real RPC, scheduler and coordinator around one thread. */
	function live() {
		const f = fixture()
		const settings = f.settings
		const scheduler = new SdkSessionRebuildScheduler({ sessions: f.options.sessions as never })
		const coordinator = new SdkProviderChangeCoordinator({ ...f.options, rebuilds: scheduler } as never)
		f.options.getTaskApiSelection = () => stable as never
		f.session.apiSnapshot = { selection: stable as never, configuration: {} }
		Object.assign(f.state, {
			getModelSettingsMigrationStatus: () => ({ status: "complete", retryable: false }),
			mutateModelSettings: async (revision: number, mutate: (value: ModelSettings) => Promise<unknown>) => {
				if (revision !== settings.revision) throw new Error("revision")
				const next = structuredClone(settings)
				await mutate(next)
				Object.assign(settings, next, { revision: revision + 1 })
			},
		})
		const controller = {
			stateManager: f.state,
			postStateToWebview: vi.fn(),
			handleApiConfigurationChanged: () => coordinator.handleApiConfigurationChanged({}, {}),
		}
		const editAct = (overrides: object) =>
			mutateSettings(
				controller as never,
				"saveConfiguredModels",
				JSON.stringify({
					expectedRevision: settings.revision,
					models: [{ ...settings.models.find((m) => m.id === "act"), overrides }],
				}),
				true,
			)
		const build = () => f.builder.build({ cwd: "/tmp", mode: "act", apiSelection: { modelSelectionV1: stable } } as never)
		const send = (config: { hooks?: { beforeModel?: (ctx: never) => unknown } }) =>
			scheduler.runExclusive(async () => config.hooks!.beforeModel!({} as never))
		return { ...f, scheduler, editAct, build, send }
	}
	const latest = (f: ReturnType<typeof live>) => f.replace.mock.calls.at(-1)?.[0].startInput.config

	it("edit, then send, succeeds on the rebuilt session with no mode switch or reload", async () => {
		const f = live()
		await f.build()
		await f.editAct({ temperature: 0.5 })
		// A send waits on the same boundary as the rebuild, so it lands on the new runtime.
		await f.send({ hooks: { beforeModel: async () => {} } })
		expect(f.replace).toHaveBeenCalledOnce()
		const rebuilt = latest(f)
		expect(rebuilt.providerConfig.temperature).toBe(0.5)
		await expect(rebuilt.hooks.beforeModel({})).resolves.toBeUndefined()
	})

	it("an already built session doesn't refuse requests after an edit, so a retry can't get stuck", async () => {
		const f = live()
		const config = await f.build()
		await f.editAct({ temperature: 0.5 })
		await expect(config.hooks!.beforeModel!({} as never)).resolves.toBeUndefined()
		await expect(config.hooks!.beforeModel!({} as never)).resolves.toBeUndefined()
	})

	it("a running turn finishes on what it started with and rebuilds when it goes idle", async () => {
		const f = live()
		const config = await f.build()
		f.session.isRunning = true
		await f.editAct({ temperature: 0.5 })
		await new Promise((resolve) => setImmediate(resolve))
		expect(f.replace).not.toHaveBeenCalled()
		await expect(config.hooks!.beforeModel!({} as never)).resolves.toBeUndefined()
		f.session.isRunning = false
		f.scheduler.sessionBecameIdle()
		await f.send(config)
		expect(latest(f).providerConfig.temperature).toBe(0.5)
	})

	it("still refuses a request whose row was deleted, saying how to fix it", async () => {
		const f = live()
		const config = await f.build()
		f.settings.models = f.settings.models.filter((m) => m.id !== "act")
		await expect(config.hooks!.beforeModel!({} as never)).rejects.toThrow(/was removed.*Pick another/)
	})

	it("spawn_agent applies a subagent policy edit to the running session instead of refusing", async () => {
		const f = live()
		const config = await f.build()
		const spawn = () => config.hooks!.beforeTool!({ toolCall: { toolName: "spawn_agent" } } as never)
		f.settings.subagents = { ...f.settings.subagents, maxConcurrent: 7, blocking: "never" }
		f.settings.roles.subagents = { kind: "model", pick: ask }
		await expect(spawn()).resolves.toBeUndefined()
		expect(config.subagentSettings?.maxConcurrent).toBe(7)
		expect(config.subagentSettings?.modelPolicy).toMatchObject({
			blocking: "never",
			default: { model: "ask", level: "default" },
		})
		expect(config.subagentSettings?.modelPolicy?.models.ask).toBeDefined()
		f.settings.subagents.enabled = false
		await expect(spawn()).rejects.toThrow("Subagents are turned off. Open Settings > Subagents.")
	})
})

describe("a broken subagent model never stops the chat", () => {
	function withBrokenModel() {
		const f = fixture()
		f.settings.connections.push({
			...f.settings.connections[0],
			id: "no-key",
			auth: { kind: "keychain", secretRef: "settings:v1:connection:no-key:apiKey" },
		} as ModelSettings["connections"][number])
		f.settings.models.push({ ...f.settings.models[0], id: "broken", name: "Broken", connectionId: "no-key" })
		f.settings.subagents.allowed = [
			{ kind: "model", modelId: "broken", levels: ["default"] },
			{ kind: "model", modelId: "ask", levels: ["default"] },
		]
		return f
	}
	const build = (f: ReturnType<typeof fixture>) =>
		f.builder.build({ cwd: "/tmp", mode: "act", apiSelection: { modelSelectionV1: stable } } as never)

	it("doesn't build subagent models at all when subagents are off", async () => {
		const f = withBrokenModel()
		f.settings.subagents.enabled = false
		const config = await build(f)
		expect(config.enableSpawnAgent).toBe(false)
		expect(config.subagentSettings).toBeUndefined()
	})

	it("leaves the broken model out and names it only when it's asked for", async () => {
		const f = withBrokenModel()
		const policy = (await build(f)).subagentSettings!.modelPolicy!
		expect(Object.keys(policy.models)).toEqual(["ask"])
		expect(policy.unavailable?.broken.name).toBe("Broken")
		expect(policy.unavailable?.broken.reason).toContain("Connection key is missing")
		expect(policy.unavailable?.broken.reason).toContain("Open Settings > Models")
	})

	it("a broken default still builds the session", async () => {
		const f = withBrokenModel()
		f.settings.roles.subagents = { kind: "model", pick: { modelId: "broken", levelId: "default" } }
		const config = await build(f)
		expect(config.modelId).toBe("act")
		expect(config.subagentSettings?.modelPolicy?.unavailable?.broken).toBeDefined()
	})

	it("a broken allowed model doesn't block the parent's other spawns", async () => {
		const f = withBrokenModel()
		const config = await build(f)
		await expect(config.hooks!.beforeTool!({ toolCall: { toolName: "spawn_agent" } } as never)).resolves.toBeUndefined()
	})
})

it("collects persisted, pending, home and next-message deletion dependencies without the UI projection", async () => {
	const { Controller } = await import("./SdkController")
	const controller = Object.create(Controller.prototype) as InstanceType<typeof Controller>
	const next = new NextMessageModelSelections()
	next.set("old-thread", "plan", { modelId: "next", levelId: "default" })
	Object.assign(controller, {
		stateManager: fixture().state,
		taskHistory: { listModelSelectionDependencies: async () => [] },
		configuredNextMessageSelections: next,
		draftApiSelection: { modelSelectionV1: { version: 1, ask: null, act: { modelId: "home", levelId: "default" } } },
		taskSessions: new Map([
			[
				"live",
				{
					apiSelection: { modelSelectionV1: stable },
					pendingApiSelection: {
						modelSelectionV1: { version: 1, ask: ask, act: { modelId: "pending", levelId: "default" } },
					},
				},
			],
		]),
	})
	const history = await controller.getModelSelectionDependencies()
	const { modelDependencies } = await import("./model-settings/host-settings")
	const settings = fixture().state.getGlobalStateKey("modelSettings") as ModelSettings
	expect(modelDependencies(controller.stateManager, settings, ["home", "next", "pending"], history)).toEqual(
		expect.arrayContaining(["thread:home:draft.act", "thread:old-thread:next-message.plan", "thread:live:pending.act"]),
	)
})

describe("a thread with a legacy selection", () => {
	const legacyPick = (f: ReturnType<typeof fixture>, apiSelection: TaskApiSelection) =>
		f.builder.build({ cwd: "/tmp", mode: "act", apiSelection } as never).then((config) => {
			return (config as unknown as { apiSnapshot: { selection: { modelSelectionV1: { act: unknown; ask: unknown } } } })
				.apiSnapshot.selection.modelSelectionV1
		})

	it("builds when its saved effort isn't on the model, at the closest level offered", async () => {
		const f = fixture()
		const ladder = [
			{ id: "default", label: "Default", rank: 0, request: { kind: "default" as const } },
			{ id: "medium", label: "medium", rank: 1, request: { kind: "effort" as const, value: "medium" } },
		]
		f.settings.models[0].overrides = { levels: ladder, reasoning: "yes" }
		const thread = await legacyPick(f, { actProfileId: "old-act", actModeReasoningEffort: "high" })
		expect(thread.act).toEqual({ modelId: "act", levelId: "medium" })
	})

	it("builds when it only recorded the other mode, on the current selection", async () => {
		const f = fixture()
		const thread = await legacyPick(f, { askProfileId: "old-ask" })
		expect(thread.ask).toEqual(ask)
		expect(thread.act).toEqual({ modelId: "new-default", levelId: "default" })
	})
})

describe("a thread whose own model is broken, when something else is edited", () => {
	/** The real RPC, scheduler and coordinator around one thread on a row with no model ID. */
	function broken() {
		const f = fixture()
		const settings = f.settings
		const scheduler = new SdkSessionRebuildScheduler({ sessions: f.options.sessions as never })
		const coordinator = new SdkProviderChangeCoordinator({ ...f.options, rebuilds: scheduler } as never)
		f.options.getTaskApiSelection = () => stable as never
		f.session.apiSnapshot = { selection: stable as never, configuration: {} }
		Object.assign(f.state, {
			getModelSettingsMigrationStatus: () => ({ status: "complete", retryable: false }),
			mutateModelSettings: async (revision: number, mutate: (value: ModelSettings) => Promise<unknown>) => {
				const next = structuredClone(settings)
				await mutate(next)
				Object.assign(settings, next, { revision: revision + 1 })
			},
		})
		const controller = {
			stateManager: f.state,
			postStateToWebview: vi.fn(),
			handleApiConfigurationChanged: () => coordinator.handleApiConfigurationChanged({}, {}),
		}
		const save = (id: string, change: object) =>
			mutateSettings(
				controller as never,
				"saveConfiguredModels",
				JSON.stringify({
					expectedRevision: settings.revision,
					models: [{ ...settings.models.find((m) => m.id === id), ...change }],
				}),
				true,
			)
		settings.models.find((m) => m.id === "act")!.upstreamId = "model-id-needed"
		const settled = () => scheduler.runExclusive(async () => {})
		return { ...f, coordinator, save, settled }
	}

	it("shows nothing and leaves the thread's status alone", async () => {
		const f = broken()
		await f.save("ask", { overrides: { temperature: 0.5 } })
		await f.settled()
		expect(f.replace).not.toHaveBeenCalled()
		expect(f.options.messages.appendAndEmit).not.toHaveBeenCalled()
		expect(f.options.sessions.setStatus).not.toHaveBeenCalled()
	})

	it("refuses only when someone sends, saying how to fix it", async () => {
		const f = broken()
		await f.save("ask", { overrides: { temperature: 0.5 } })
		await f.settled()
		await expect(f.coordinator.retryRefusedRebuild("thread")).resolves.toMatch(/no model ID.*Settings > Models/)
		expect(f.options.messages.appendAndEmit).not.toHaveBeenCalled()
		// Still broken: the next send refuses again.
		await expect(f.coordinator.retryRefusedRebuild("thread")).resolves.toMatch(/no model ID/)
	})

	it("once fixed, the edit that fixes it rebuilds the thread and a send has nothing to retry", async () => {
		const f = broken()
		await f.save("ask", { overrides: { temperature: 0.5 } })
		await f.settled()
		await f.save("act", { upstreamId: "real" })
		await f.settled()
		expect(f.replace).toHaveBeenCalledOnce()
		await expect(f.coordinator.retryRefusedRebuild("thread")).resolves.toBeUndefined()
		expect(f.replace).toHaveBeenCalledOnce()
	})

	it("a send fixes a thread nothing has rebuilt since the fix", async () => {
		const f = broken()
		await f.save("ask", { overrides: { temperature: 0.5 } })
		await f.settled()
		f.settings.models.find((m) => m.id === "act")!.upstreamId = "real"
		await expect(f.coordinator.retryRefusedRebuild("thread")).resolves.toBeUndefined()
		expect(f.replace).toHaveBeenCalledOnce()
	})

	it("a failure replacing the session is still reported", async () => {
		const f = fixture()
		const coordinator = new SdkProviderChangeCoordinator({
			...f.options,
			rebuilds: {
				request: (_reason: string, run: (context: unknown) => Promise<void>) => void run({ isCurrent: () => true }),
			},
		} as never)
		f.options.getTaskApiSelection = () => stable as never
		f.replace.mockRejectedValueOnce(new Error("boom"))
		coordinator.handleApiConfigurationChanged({}, {})
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))
		expect(f.options.messages.appendAndEmit).toHaveBeenCalledOnce()
	})
})

describe("another rebuild trigger on a thread whose own model is broken", () => {
	const brokenOn = (reason: string) => {
		const f = fixture()
		const refusedRebuilds = new Set<string>()
		const options = { ...f.options, refusedRebuilds }
		const pinned = { modelSelectionV1: stable }
		f.session.apiSnapshot = { selection: pinned as never, configuration: {} }
		f.options.getTaskApiSelection = () => pinned as never
		f.settings.models.find((m) => m.id === "act")!.upstreamId = "model-id-needed"
		const run = async () => {
			if (reason === "mcp") {
				await new SdkMcpCoordinator(options as never).restartSessionForMcpTools("thread")
				return
			}
			const coordinator = new SdkSessionConfigChangeCoordinator(options as never)
			if (reason === "checkpoints") coordinator.handleCheckpointsSettingChanged(false, true)
			if (reason === "subagents") coordinator.handleSubagentSettingsChanged()
			if (reason === "terminal") coordinator.handleTerminalExecutionModeChanged("backgroundExec", "vscodeTerminal")
			if (reason === "taskGroup") coordinator.handleTaskGroupChanged("thread")
			await f.drain()
		}
		return { ...f, options, refusedRebuilds, run }
	}
	const triggers = ["checkpoints", "subagents", "terminal", "taskGroup", "mcp"]

	it.each(triggers)("%s shows nothing and leaves the thread idle", async (reason) => {
		const f = brokenOn(reason)
		await f.run()
		expect(f.replace).not.toHaveBeenCalled()
		expect(f.options.messages.appendAndEmit).not.toHaveBeenCalled()
		expect(f.refusedRebuilds.has("thread")).toBe(true)
		expect(f.options.messages.emitSessionEvents).toHaveBeenLastCalledWith([], {
			type: "status",
			payload: { sessionId: "thread", status: "idle" },
		})
	})
	it.each(triggers)("after %s the thread refuses on send, saying how to fix it", async (reason) => {
		const f = brokenOn(reason)
		await f.run()
		const provider = new SdkProviderChangeCoordinator(f.options as never)
		await expect(provider.retryRefusedRebuild("thread")).resolves.toMatch(/no model ID.*Settings > Models/)
		expect(f.options.messages.appendAndEmit).not.toHaveBeenCalled()
		// Fixed since: the send goes through on a rebuilt session.
		f.settings.models.find((m) => m.id === "act")!.upstreamId = "real"
		await expect(provider.retryRefusedRebuild("thread")).resolves.toBeUndefined()
		expect(f.replace).toHaveBeenCalledOnce()
	})
	it.each(triggers)("a failure replacing the session after %s is still reported", async (reason) => {
		const f = brokenOn(reason)
		f.settings.models.find((m) => m.id === "act")!.upstreamId = "act"
		f.replace.mockRejectedValueOnce(new Error("boom"))
		await f.run()
		expect(f.options.messages.appendAndEmit).toHaveBeenCalledOnce()
		expect(f.refusedRebuilds.has("thread")).toBe(false)
	})
	it("a later build that works clears the refusal", async () => {
		const f = brokenOn("subagents")
		await f.run()
		f.settings.models.find((m) => m.id === "act")!.upstreamId = "real"
		await f.run()
		expect(f.replace).toHaveBeenCalledOnce()
		expect(f.refusedRebuilds.has("thread")).toBe(false)
	})
})

describe("what a configured session publishes (B2)", () => {
	const levels = [
		{ id: "default", label: "Default", rank: 0, request: { kind: "default" as const } },
		{ id: "high", label: "High", rank: 1, request: { kind: "effort" as const, value: "high" } },
	]
	const built = async (levelId: string, mode: "act" | "plan" = "act") => {
		const f = fixture()
		const row = f.settings.models.find((m) => m.id === (mode === "act" ? "act" : "ask"))!
		row.overrides = { reasoning: "yes", levels }
		const pick = { modelId: row.id, levelId }
		const config = await f.builder.build({
			cwd: "/tmp",
			mode,
			apiSelection: { modelSelectionV1: { version: 1, act: pick, ask: pick } },
		} as never)
		return focusedModelsFromSnapshot(getSessionApiSnapshot(config), undefined)
	}
	it("is the real model and effort, never unknown", async () => {
		expect(await built("high")).toEqual({
			act: {
				provider: "openai",
				modelId: "act",
				reasoningEffort: "high",
				pick: { modelId: "act", levelId: "high" },
			},
		})
	})
	it("names no effort for the default level", async () => {
		expect((await built("default"))?.act).toMatchObject({ modelId: "act", reasoningEffort: undefined })
	})
	it("speaks only for the mode it was built in", async () => {
		const published = await built("high", "plan")
		expect(published?.act).toBeUndefined()
		expect(published?.plan).toMatchObject({ modelId: "ask", pick: { modelId: "ask" } })
	})
	it("a legacy session still publishes from its configuration", () => {
		expect(
			focusedModelsFromSnapshot(
				{
					selection: { askProfileId: "a", actProfileId: "b" },
					configuration: { actModeApiProvider: "openai", actModeOpenAiModelId: "m", actModeReasoningEffort: "low" },
				},
				{ askProfileId: "a", actProfileId: "b" },
			)?.act,
		).toEqual({ profileId: "b", provider: "openai", modelId: "m", reasoningEffort: "low" })
	})
})

describe("an organization change under a built session", () => {
	it("tells people to send again, not to reload", async () => {
		const f = fixture()
		const config = await f.builder.build({ cwd: "/tmp", mode: "act", apiSelection: { modelSelectionV1: stable } } as never)
		;(f.state.getRemoteConfigSettings() as Record<string, unknown>).remoteProviderSettings = {
			OpenAiCompatible: { models: [{ id: "act", contextWindow: 1234 }] },
		}
		await expect(config.hooks!.beforeModel!({} as never)).rejects.toThrow(/Send your message again.*Settings > Models/)
		await expect(config.hooks!.beforeModel!({} as never)).rejects.not.toThrow(/Reload/)
	})
})
