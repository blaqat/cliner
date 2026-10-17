import { ModelProfile, UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, expect, it, vi } from "vitest"
import { getStateToPostToWebview } from "./getStateToPostToWebview"
import { updateSettings } from "./updateSettings"

vi.mock("@/config", () => ({ ClineEnv: { config: () => ({ environment: "test" }) } }))
vi.mock("@/registry", () => ({ ExtensionRegistryInfo: { version: "test" } }))
vi.mock("@/services/banner/BannerService", () => ({
	BannerService: { get: () => ({ getActiveBanners: () => [], getWelcomeBanners: () => [] }) },
}))
vi.mock("@/services/feature-flags", () => ({ featureFlagsService: { getWorktreesEnabled: () => false } }))
vi.mock("@/services/logging/distinctId", () => ({ getDistinctId: () => "test" }))
vi.mock("@/services/telemetry/rollout-metadata", () => ({ getExtensionVariant: () => "test" }))
vi.mock("@/utils/announcements", () => ({ getLatestAnnouncementId: () => "test" }))
vi.mock("@core/hooks/hooks-utils", () => ({ getHooksEnabledSafe: () => false }))
vi.mock("../models/getClineOnboardingModels", () => ({ getClineOnboardingModels: () => [] }))
vi.mock("@/integrations/openai-codex/oauth", () => ({ openAiCodexOAuthManager: { isAuthenticated: async () => false } }))

const configurations = [
	{ id: "cfg-claude", name: "Claude", provider: "anthropic", modelId: "claude-x", reasoningEffort: "high" },
	{ id: "cfg-local", name: "Local", provider: "openai", modelId: "qwen" },
]

/** In-memory StateManager stand-in: one map for state, one for the mode keys. */
function makeController() {
	const state: Record<string, unknown> = {
		apiConfigProfiles: configurations,
		askProfileId: "cfg-local",
		actProfileId: "cfg-local",
		profiles: [],
	}
	const apiConfiguration: Record<string, unknown> = {}
	const stateManager = {
		getApiConfiguration: () => apiConfiguration,
		setApiConfiguration: (updates: Record<string, unknown>) => Object.assign(apiConfiguration, updates),
		getGlobalStateKey: (key: string) => state[key],
		getGlobalSettingsKey: (key: string) => state[key],
		getWorkspaceStateKey: () => undefined,
		setGlobalState: vi.fn((key: string, value: unknown) => {
			state[key] = value
		}),
		setGlobalStateBatch: (updates: Record<string, unknown>) => Object.assign(state, updates),
		getSecretForKey: () => undefined,
		setSecretsForKeys: () => {},
		listSecretStorageKeys: () => [],
	}
	return {
		state,
		apiConfiguration,
		stateManager,
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		handleApiConfigurationChanged: vi.fn(),
		handleSubagentSettingsChanged: vi.fn(),
	}
}

const send = (controller: ReturnType<typeof makeController>, request: Partial<UpdateSettingsRequest>) =>
	updateSettings(controller as never, UpdateSettingsRequest.create(request))

describe("profile settings", () => {
	it("round-trips create, edit and delete to the webview state", async () => {
		const controller = makeController()
		await send(controller, {
			profiles: {
				values: [
					ModelProfile.create({ name: "Fast", configurationId: "cfg-local", reasoningEffort: "low" }),
					ModelProfile.create({ name: "Deep", configurationId: "cfg-claude", reasoningEffort: "xhigh" }),
				],
			},
		})
		let state = await getStateToPostToWebview(controller as never)
		expect(state.profiles?.map((p) => [p.name, p.configurationId, p.reasoningEffort])).toEqual([
			["Fast", "cfg-local", "low"],
			["Deep", "cfg-claude", "xhigh"],
		])
		const [fast, deep] = state.profiles ?? []
		expect(state.threadDefaultProfileId).toBe(fast.id)
		// Profiles feed subagent connections, so live sessions pick up edits.
		expect(controller.handleSubagentSettingsChanged).toHaveBeenCalled()

		await send(controller, {
			profiles: {
				values: [
					ModelProfile.create({ ...fast, reasoningEffort: fast.reasoningEffort }),
					ModelProfile.create({ id: deep.id, name: "Deeper", configurationId: "cfg-local", reasoningEffort: "none" }),
				],
			},
		})
		state = await getStateToPostToWebview(controller as never)
		expect(state.profiles?.find((p) => p.id === deep.id)).toEqual({
			id: deep.id,
			name: "Deeper",
			configurationId: "cfg-local",
			reasoningEffort: undefined,
		})

		await send(controller, { profiles: { values: [ModelProfile.create({ ...fast })] } })
		state = await getStateToPostToWebview(controller as never)
		expect(state.profiles?.map((p) => p.id)).toEqual([fast.id])
	})

	it("rejects ids that are not profiles", async () => {
		const controller = makeController()
		await expect(send(controller, { threadDefaultProfileId: "cfg-claude" })).rejects.toThrow("Unknown profile")
		await expect(send(controller, { walkthroughGenerateProfileId: "cfg-claude" })).rejects.toThrow("Unknown profile")
	})

	it("applies the Thread defaults, per mode behind the switch, to what new threads start on", async () => {
		const controller = makeController()
		await send(controller, {
			profiles: {
				values: [
					ModelProfile.create({ id: "fast", name: "Fast", configurationId: "cfg-local", reasoningEffort: "low" }),
					ModelProfile.create({ id: "deep", name: "Deep", configurationId: "cfg-claude", reasoningEffort: "xhigh" }),
				],
			},
		})
		await send(controller, { threadDefaultProfileId: "deep" })
		expect(controller.state.askProfileId).toBe("cfg-claude")
		expect(controller.state.actProfileId).toBe("cfg-claude")
		expect(controller.apiConfiguration).toMatchObject({ planModeReasoningEffort: "xhigh", actModeReasoningEffort: "xhigh" })
		expect(controller.handleApiConfigurationChanged).toHaveBeenCalled()

		// The switch on: Ask and Act each get their own profile.
		await send(controller, { threadSeparateAskActProfiles: true, threadAskProfileId: "deep", threadActProfileId: "fast" })
		expect(controller.state.askProfileId).toBe("cfg-claude")
		expect(controller.state.actProfileId).toBe("cfg-local")
		expect(controller.apiConfiguration).toMatchObject({ planModeReasoningEffort: "xhigh", actModeReasoningEffort: "low" })
		const state = await getStateToPostToWebview(controller as never)
		expect(state).toMatchObject({
			threadSeparateAskActProfiles: true,
			threadAskProfileId: "deep",
			threadActProfileId: "fast",
			threadDefaultProfileId: "deep",
		})

		// The switch off: the shared default applies to both again.
		await send(controller, { threadSeparateAskActProfiles: false, threadDefaultProfileId: "fast" })
		expect(controller.state.askProfileId).toBe("cfg-local")
		expect(controller.apiConfiguration).toMatchObject({ planModeReasoningEffort: "low", actModeReasoningEffort: "low" })
	})
})
