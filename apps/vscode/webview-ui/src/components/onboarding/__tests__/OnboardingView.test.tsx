import { createDefaultModelSettings } from "@shared/model-settings"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeHost, type FakeHost } from "../../settings/models/modelsPage.fixture"
import OnboardingView from "../OnboardingView"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	host: {} as Record<string, unknown>,
	saveApiProfile: vi.fn(),
	assignApiProfile: vi.fn(),
	updateSettings: vi.fn(),
	setWelcomeViewCompleted: vi.fn(),
	captureOnboardingProgress: vi.fn(),
	retry: vi.fn(),
	openLogs: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => ({ activeOrganization: null, clineUser: null }) }))
vi.mock("@/components/navigation/NavigationHistoryContext", () => ({ useNavigationHistory: () => undefined }))
vi.mock("@/hooks/useProviderListings", () => ({ useProviderListings: () => ({ listings: [], error: undefined }) }))
vi.mock("@/components/settings/sections/DebugSection", () => ({ default: () => null }))
vi.mock("@/components/settings/sections/RemoteConfigSection", () => ({ RemoteConfigSection: () => null }))
vi.mock("@/components/settings/environment/TerminalEnvironmentEditor", () => ({ default: () => null }))
vi.mock("@/components/worktrees/WorktreeSettings", () => ({ WorktreeSettings: () => null }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: new Proxy(
		{},
		{
			get: (_target, name: string) =>
				name === "saveApiProfile"
					? mocks.saveApiProfile
					: name === "assignApiProfile"
						? mocks.assignApiProfile
						: name === "retryModelSettingsMigration"
							? mocks.retry
							: mocks.host[name],
		},
	),
	StateServiceClient: {
		updateSettings: mocks.updateSettings,
		setWelcomeViewCompleted: mocks.setWelcomeViewCompleted,
		captureOnboardingProgress: mocks.captureOnboardingProgress,
	},
	UiServiceClient: { openLogs: mocks.openLogs },
}))

const start = (host: FakeHost, extra: Record<string, unknown> = {}) => {
	mocks.host = host.client
	mocks.state = {
		hideAccount: vi.fn(),
		hideSettings: vi.fn(),
		setShowWelcome: vi.fn(),
		remoteConfigSettings: {},
		modelSettings: host.state(),
		...extra,
	}
}

const withModel = () => {
	const settings = createDefaultModelSettings()
	settings.connections = [
		{
			id: "c",
			kind: "openai-compatible",
			name: "C",
			baseUrl: "http://x/v1",
			auth: { kind: "none" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			apiFormat: "chat",
			azureApiVersion: null,
		},
	]
	settings.models = [
		{ id: "m1", connectionId: "c", upstreamId: "m1", name: "", kind: "chat", overrides: {}, providerOptions: {} },
	]
	return settings
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.setWelcomeViewCompleted.mockResolvedValue({})
})

describe("OnboardingView", () => {
	it("is the Models page, with one way out once there's a model", () => {
		start(createFakeHost())
		render(<OnboardingView />)
		expect(screen.getByText("Set up your first model")).toBeVisible()
		expect(screen.getByTestId("settings-page-models")).toBeInTheDocument()
		expect(screen.queryByLabelText("Search settings")).toBeNull()
		const next = screen.getByRole("button", { name: "Continue" })
		expect(next).toBeDisabled()
		expect(next).toHaveAttribute("title", "Add a model first")
		expect(screen.getByText(/Nothing can run yet/)).toBeVisible()
	})

	it("offers every way to add a model, not four providers", () => {
		start(createFakeHost())
		render(<OnboardingView />)
		expect(screen.getByRole("button", { name: /OpenAI-compatible|Add connection/i })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /other provider|another provider|Add provider/i })).toBeInTheDocument()
	})

	it("Continue runs Chat and Background text on the first model, through the new store only", async () => {
		const host = createFakeHost({ settings: withModel() })
		start(host)
		render(<OnboardingView />)
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		await waitFor(() => expect(mocks.setWelcomeViewCompleted).toHaveBeenCalledWith(expect.objectContaining({ value: true })))
		const { roles } = host.state().settings
		expect(roles.chat).toEqual({ modelId: "m1", levelId: "default" })
		expect(roles.background.pick).toEqual({ modelId: "m1", levelId: "default" })
		expect(mocks.saveApiProfile).not.toHaveBeenCalled()
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		expect(mocks.updateSettings).not.toHaveBeenCalled()
		expect(mocks.state.setShowWelcome).toHaveBeenCalledWith(false)
	})

	it("keeps what was already picked", async () => {
		const settings = withModel()
		settings.models.push({ ...settings.models[0], id: "m2", upstreamId: "m2" })
		settings.roles.chat = { modelId: "m2", levelId: "default" }
		const host = createFakeHost({ settings })
		start(host)
		render(<OnboardingView />)
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		await waitFor(() => expect(mocks.setWelcomeViewCompleted).toHaveBeenCalled())
		const { roles } = host.state().settings
		expect(roles.chat?.modelId).toBe("m2")
		expect(roles.background.pick?.modelId).toBe("m2")
	})

	it("Ask runs on it too when Ask has its own role on", async () => {
		const settings = withModel()
		settings.roles.ask.enabled = true
		const host = createFakeHost({ settings })
		start(host)
		render(<OnboardingView />)
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		await waitFor(() => expect(mocks.setWelcomeViewCompleted).toHaveBeenCalled())
		expect(host.state().settings.roles.ask.pick?.modelId).toBe("m1")
	})

	it("stays put and says why when the save fails", async () => {
		const host = createFakeHost({ settings: withModel() })
		start(host)
		mocks.host = { ...host.client, setModelRoles: () => Promise.reject(new Error("no such model")) }
		render(<OnboardingView />)
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		expect(await screen.findByText("no such model")).toBeVisible()
		expect(mocks.setWelcomeViewCompleted).not.toHaveBeenCalled()
		expect(mocks.state.setShowWelcome).not.toHaveBeenCalled()
	})

	it("before the setup has moved, says why and offers the retry instead of a form", () => {
		start(createFakeHost(), {
			modelSettings: undefined,
			modelSettingsMigrationStatus: { status: "failed", retryable: true, cause: "The keychain refused" },
		})
		render(<OnboardingView />)
		expect(screen.getByText("The keychain refused")).toBeVisible()
		expect(screen.getByRole("button", { name: "Retry" })).toBeVisible()
		expect(screen.getByRole("button", { name: "Open logs" })).toBeVisible()
		expect(screen.queryByText("Set up your first model")).toBeNull()
	})
})
