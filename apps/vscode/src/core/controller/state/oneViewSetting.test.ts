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
		getRemoteConfigSettings: () => ({}),
		getApiConfiguration: () => ({}),
		getGlobalStateKey: () => undefined,
		getModelSettingsMigrationStatus: () => ({ status: "pending", retryable: false }),
		getGlobalSettingsKey: (key: string) => settings[key],
		getWorkspaceStateKey: () => undefined,
		setGlobalState: vi.fn((key: string, value: unknown) => {
			settings[key] = value
		}),
	}
	return { stateManager, postStateToWebview: vi.fn().mockResolvedValue(undefined) }
}

describe("one view setting", () => {
	it("is off until turned on, and round-trips to the webview state", async () => {
		const controller = makeController()
		await updateSettings(controller as never, UpdateSettingsRequest.create({ threadToastSeconds: 8 }))
		expect(controller.stateManager.setGlobalState).not.toHaveBeenCalledWith("oneViewEnabled", expect.anything())
		await updateSettings(controller as never, UpdateSettingsRequest.create({ oneViewEnabled: true }))
		expect((await getStateToPostToWebview(controller as never)).oneViewEnabled).toBe(true)
		await updateSettings(controller as never, UpdateSettingsRequest.create({ oneViewEnabled: false }))
		expect((await getStateToPostToWebview(controller as never)).oneViewEnabled).toBe(false)
		expect(controller.postStateToWebview).toHaveBeenCalledWith(true)
	})
})

it("round-trips task progress and telemetry without exposing headers", async () => {
	const controller = makeController()
	const request = UpdateSettingsRequest.create({
		focusChainSettings: { enabled: false, remindClineInterval: 9 },
		openTelemetryEnabled: false,
		openTelemetryOtlpEndpoint: "http://localhost:4318",
		openTelemetryLogBatchSize: 32,
	})
	const decoded = UpdateSettingsRequest.decode(UpdateSettingsRequest.encode(request).finish())
	await updateSettings(controller as never, decoded)
	const state = await getStateToPostToWebview(controller as never)
	expect(state.focusChainSettings).toEqual({ enabled: false, remindClineInterval: 9 })
	expect(state.openTelemetrySettings).toMatchObject({
		openTelemetryEnabled: false,
		openTelemetryLogBatchSize: 32,
		openTelemetryOtlpEndpoint: "http://localhost:4318",
	})
	expect(Object.keys(state.openTelemetrySettings!)).not.toContain("openTelemetryOtlpHeaders")
})
it("refuses a managed telemetry write before applying changes", async () => {
	const controller = makeController()
	controller.stateManager.getRemoteConfigSettings = () => ({ openTelemetryEnabled: true })
	await expect(
		updateSettings(controller as never, UpdateSettingsRequest.create({ openTelemetryEnabled: false })),
	).rejects.toThrow("Managed setting")
	expect(controller.stateManager.setGlobalState).not.toHaveBeenCalled()
})

it("masks collector header values in ordinary remote state", async () => {
	const controller = makeController()
	controller.stateManager.getRemoteConfigSettings = () => ({
		openTelemetryOtlpHeaders: { Authorization: "private" },
		otlpMetricsHeaders: { token: "private" },
		otlpLogsHeaders: { token: "private" },
	})
	const state = await getStateToPostToWebview(controller as never)
	expect(JSON.stringify(state.remoteConfigSettings)).not.toContain("private")
	expect(state.remoteConfigSettings?.openTelemetryOtlpHeaders).toEqual({ Authorization: "********" })
})
