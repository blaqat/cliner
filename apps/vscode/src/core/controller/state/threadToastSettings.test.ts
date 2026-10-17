import { UpdateSettingsRequest } from "@shared/proto/cline/state"
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

/** An in-memory settings store standing in for the real StateManager. */
function makeController() {
	const settings: Record<string, unknown> = {}
	const stateManager = {
		getApiConfiguration: () => ({}),
		getGlobalStateKey: () => undefined,
		getGlobalSettingsKey: (key: string) => settings[key],
		getWorkspaceStateKey: () => undefined,
		setGlobalState: vi.fn((key: string, value: unknown) => {
			settings[key] = value
		}),
	}
	return { stateManager, postStateToWebview: vi.fn().mockResolvedValue(undefined) }
}

describe("thread toast settings", () => {
	it("round-trips on/off and duration to the webview state", async () => {
		const controller = makeController()
		await updateSettings(
			controller as never,
			UpdateSettingsRequest.create({ threadToastsEnabled: false, threadToastSeconds: 12 }),
		)
		const state = await getStateToPostToWebview(controller as never)
		expect(state.threadToastsEnabled).toBe(false)
		expect(state.threadToastSeconds).toBe(12)
		expect(controller.postStateToWebview).toHaveBeenCalled()
	})

	it("leaves the other toast setting alone when only one is sent", async () => {
		const controller = makeController()
		await updateSettings(controller as never, UpdateSettingsRequest.create({ threadToastSeconds: 8 }))
		expect(controller.stateManager.setGlobalState).toHaveBeenCalledTimes(1)
		await updateSettings(controller as never, UpdateSettingsRequest.create({ threadToastsEnabled: true }))
		const state = await getStateToPostToWebview(controller as never)
		expect(state).toMatchObject({ threadToastsEnabled: true, threadToastSeconds: 8 })
	})

	it.each([0, -3, 2.5])("rejects a duration of %s", async (seconds) => {
		const controller = makeController()
		await expect(
			updateSettings(controller as never, UpdateSettingsRequest.create({ threadToastSeconds: seconds })),
		).rejects.toThrow(/seconds/)
		expect(controller.stateManager.setGlobalState).not.toHaveBeenCalled()
	})
})
