import { describe, expect, it, vi } from "vitest"
import { retryModelSettingsMigration } from "../models/retryModelSettingsMigration"
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
vi.mock("@/sdk/model-settings/rollout", () => ({ MODEL_SETTINGS_ROLLOUT_ENABLED: true, modelSettingsRolloutEnabled: () => true }))

describe("model settings migration status", () => {
	it("reaches the webview before the journal is complete, so a failed first migration can be retried", async () => {
		const failed = { status: "failed", retryable: true, cause: "Could not write to the connection keychain" }
		const controller = {
			stateManager: {
				getRemoteConfigSettings: () => ({}),
				getApiConfiguration: () => ({}),
				getGlobalStateKey: () => undefined,
				getGlobalSettingsKey: () => undefined,
				getWorkspaceStateKey: () => undefined,
				getModelSettingsMigrationStatus: () => failed,
			},
		}
		const state = await getStateToPostToWebview(controller as never)
		expect(state.modelSettings).toBeUndefined()
		expect(state.modelSettingsMigrationStatus).toEqual(failed)
	})

	it("a retry tells the webview, so Settings moves on without a reload", async () => {
		const order: string[] = []
		const controller = {
			stateManager: {
				retryModelSettingsMigration: async () => void order.push("retry"),
				getModelSettingsMigrationStatus: () => ({ status: "complete", retryable: false }),
			},
			postStateToWebview: async () => void order.push("post"),
		}
		const response = await retryModelSettingsMigration(controller as never, {} as never)
		expect(order).toEqual(["retry", "post"])
		expect(JSON.parse(response.json)).toEqual({ status: "complete", retryable: false })
	})
})
