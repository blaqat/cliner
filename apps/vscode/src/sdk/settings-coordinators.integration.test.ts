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
import { SdkSessionConfigChangeCoordinator } from "./sdk-session-config-change-coordinator"
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
