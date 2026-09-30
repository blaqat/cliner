import { describe, expect, it, vi } from "vitest"
import { getStateToPostToWebview } from "./getStateToPostToWebview"

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

describe("profile state serialization", () => {
	it.each([
		{ profiles: [] },
		{ profiles: [{ id: "b", name: "B", provider: "openai", modelId: "B" }] },
	])("does not seed profiles or repair assignments for %j", async ({ profiles }) => {
		const stored: Record<string, unknown> = { apiConfigProfiles: profiles, askProfileId: "missing", actProfileId: undefined }
		const stateManager = {
			getApiConfiguration: () => ({ openAiApiKey: "legacy-key" }),
			getGlobalStateKey: (key: string) => stored[key],
			getGlobalSettingsKey: () => undefined,
			getWorkspaceStateKey: () => undefined,
			setGlobalStateBatch: vi.fn(() => {
				throw new Error("Serialization must not write state")
			}),
			setSecretsForKeys: vi.fn(() => {
				throw new Error("Serialization must not write secrets")
			}),
		}
		const state = await getStateToPostToWebview({ stateManager })
		expect(state.apiConfigProfiles).toEqual(profiles)
		expect(state.askProfileId).toBe("missing")
		expect(state.actProfileId).toBeUndefined()
		expect(stateManager.setGlobalStateBatch).not.toHaveBeenCalled()
		expect(stateManager.setSecretsForKeys).not.toHaveBeenCalled()
	})
})
