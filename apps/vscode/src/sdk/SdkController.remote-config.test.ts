import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
	clear: vi.fn(),
	useModelSettings: vi.fn(() => true),
}))

vi.mock("@/core/storage/StateManager", () => {
	const stub: unknown = new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : vi.fn(() => undefined)) })
	return { StateManager: { get: () => stub, instance: stub } }
})
vi.mock("@/services/telemetry", () => ({
	telemetryService: new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : vi.fn()) }),
}))
vi.mock("./sdk-telemetry", async (importOriginal) => ({
	...((await importOriginal()) as object),
	createVscodeSdkTelemetryHandle: () => ({ telemetry: {}, dispose: vi.fn() }),
}))
vi.mock("@/services/auth/AuthService", () => ({ AuthService: { getInstance: () => ({}) } }))
vi.mock("@/services/auth/oca/OcaAuthService", () => ({ OcaAuthService: { initialize: () => ({}) } }))
vi.mock("@/core/storage/remote-config/sdk-refresh", () => ({
	refreshSdkRemoteConfig: mocks.refresh,
	clearSdkRemoteConfig: mocks.clear,
}))
vi.mock("./model-settings/background", async (importOriginal) => ({
	...((await importOriginal()) as object),
	useModelSettings: mocks.useModelSettings,
}))

import { Controller } from "./SdkController"

/** The real refresh and sign-out, with only the fetch and the settings store replaced. */
function harness() {
	let managed: Record<string, unknown> = {}
	const handleApiConfigurationChanged = vi.fn()
	const configuration = { actModeApiProvider: "openai" }
	const controller = {
		stateManager: {
			getRemoteConfigSettings: () => managed,
			getApiConfiguration: () => configuration,
		},
		getRemoteConfigWorkspacePath: async () => "/tmp/remote",
		refreshUserInstructionWatchers: vi.fn(async () => {}),
		handleApiConfigurationChanged,
		rebuildIfManagedSettingsChanged: (Controller.prototype as any).rebuildIfManagedSettingsChanged,
	}
	const refresh = (isCurrent = () => true) =>
		(Controller.prototype as any).performRemoteConfigRefresh.call(controller, isCurrent) as Promise<boolean>
	return { controller, handleApiConfigurationChanged, configuration, refresh, setManaged: (v: typeof managed) => (managed = v) }
}

describe("a Remote Config refresh", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.useModelSettings.mockReturnValue(true)
	})

	it("rebuilds sessions when the organization's values changed", async () => {
		const f = harness()
		mocks.refresh.mockImplementation(async () => {
			f.setManaged({ openAiBaseUrl: "https://managed.test/v1" })
			return true
		})
		await expect(f.refresh()).resolves.toBe(true)
		expect(f.handleApiConfigurationChanged).toHaveBeenCalledOnce()
		expect(f.handleApiConfigurationChanged).toHaveBeenCalledWith(f.configuration, f.configuration)
	})

	it("leaves sessions alone when nothing changed, since this runs on a timer", async () => {
		const f = harness()
		f.setManaged({ openAiBaseUrl: "https://managed.test/v1" })
		mocks.refresh.mockImplementation(async () => {
			f.setManaged({ openAiBaseUrl: "https://managed.test/v1" })
			return true
		})
		await f.refresh()
		expect(f.handleApiConfigurationChanged).not.toHaveBeenCalled()
	})

	it("leaves sessions alone when superseded", async () => {
		const f = harness()
		mocks.refresh.mockImplementation(async () => {
			f.setManaged({ openAiBaseUrl: "https://managed.test/v1" })
			return false
		})
		await expect(f.refresh(() => false)).resolves.toBe(false)
		expect(f.handleApiConfigurationChanged).not.toHaveBeenCalled()
	})

	it("doesn't touch sessions while the new settings aren't what runs", async () => {
		mocks.useModelSettings.mockReturnValue(false)
		const f = harness()
		mocks.refresh.mockImplementation(async () => {
			f.setManaged({ openAiBaseUrl: "https://managed.test/v1" })
			return true
		})
		await f.refresh()
		expect(f.handleApiConfigurationChanged).not.toHaveBeenCalled()
	})

	it("signing out clears the organization's values and rebuilds too", async () => {
		const f = harness()
		f.setManaged({ openAiBaseUrl: "https://managed.test/v1" })
		mocks.clear.mockImplementation(async () => {
			f.setManaged({})
		})
		await (Controller.prototype.handleSignOut as any).call({
			...f.controller,
			getSessionProviderId: () => "openai",
			getActiveProviderId: () => "openai",
			authService: { getActiveOrganizationId: () => "org", handleDeauth: vi.fn(async () => {}) },
			taskControl: { cancelClineTaskOnSignOut: vi.fn(async () => {}) },
			remoteConfigRefreshCoordinator: { invalidate: vi.fn() },
			postStateToWebview: vi.fn(async () => {}),
		})
		expect(f.handleApiConfigurationChanged).toHaveBeenCalledOnce()
	})
})
