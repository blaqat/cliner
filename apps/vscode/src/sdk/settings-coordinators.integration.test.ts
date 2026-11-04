import type { TaskApiSelection } from "@shared/api-profiles"
import type { ModelSettings } from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { getSessionApiSnapshot } from "./cline-session-factory"
import { InMemoryConnectionSecretStore } from "./model-settings/connection-secret-store"
import { NextMessageModelSelections } from "./model-settings-resolver"
import { SdkMcpCoordinator } from "./sdk-mcp-coordinator"
import { SdkModeCoordinator } from "./sdk-mode-coordinator"
import { SdkProviderChangeCoordinator } from "./sdk-provider-change-coordinator"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"
import { SdkSessionConfigChangeCoordinator } from "./sdk-session-config-change-coordinator"
import { SdkTaskStartCoordinator } from "./sdk-task-start-coordinator"
import { prepareTaskResumeStartInput } from "./sdk-task-resume"

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
		await expect(prepareTaskResumeStartInput(deps as never, "thread")).rejects.toThrow(/model.*Settings > Models/i)
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
		enabled: false,
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
	expect(config.enableSpawnAgent).toBe(false)
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

it("uses managed remote model values and refuses an obsolete projection in a live session", async () => {
	const f = fixture()
	const managed = f.state.getRemoteConfigSettings() as Record<string, unknown>
	managed.remoteProviderSettings = { OpenAiCompatible: { models: [{ id: "act", contextWindow: 42000, maxTokens: 1000 }] } }
	const builder = new SdkSessionConfigBuilder({ stateManager: f.state as never, emitHookMessage: vi.fn() })
	const config = await builder.build({ cwd: "/tmp", mode: "act", apiSelection: { modelSelectionV1: stable } } as never)
	expect(config.providerConfig?.maxOutputTokens).toBe(1000)
	expect(config.providerConfig?.knownModels?.act.contextWindow).toBe(42000)
	managed.remoteProviderSettings = { OpenAiCompatible: { models: [{ id: "act", contextWindow: 32000 }] } }
	await expect(config.hooks!.beforeModel!({} as never)).rejects.toThrow(/settings changed/i)
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
