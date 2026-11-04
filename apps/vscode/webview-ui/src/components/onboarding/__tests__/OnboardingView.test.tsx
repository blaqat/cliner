import { createDefaultModelSettings } from "@shared/model-settings"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
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
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: new Proxy(
		{},
		{
			get: (_target, name: string) =>
				name === "saveApiProfile"
					? mocks.saveApiProfile
					: name === "assignApiProfile"
						? mocks.assignApiProfile
						: mocks.host[name],
		},
	),
	StateServiceClient: {
		updateSettings: mocks.updateSettings,
		setWelcomeViewCompleted: mocks.setWelcomeViewCompleted,
		captureOnboardingProgress: mocks.captureOnboardingProgress,
	},
}))
vi.mock("@/hooks/useProviderModels", () => ({
	useProviderModels: () => ({ models: { "claude-x": {}, "claude-y": {} }, defaultModelId: "claude-x" }),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, disabled, onClick, ...rest }: any) => (
		<button aria-label={rest["aria-label"]} disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeDropdown: ({ children, onChange, value, ...rest }: any) => (
		<select aria-label={rest["aria-label"]} id={rest.id} onChange={onChange} value={value}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: { children?: ReactNode; value: string }) => <option value={value}>{children}</option>,
	VSCodeTextField: ({ children, onInput, value, placeholder, ...rest }: any) => (
		<label>
			{children}
			<input data-testid={rest["data-testid"]} onChange={onInput} placeholder={placeholder} value={value} />
		</label>
	),
	VSCodeCheckbox: ({ children }: any) => <label>{children}</label>,
}))

describe("OnboardingView with the new store in use", () => {
	let host: FakeHost
	const fill = () => {
		fireEvent.change(screen.getByTestId("option-openAiBaseUrl"), { target: { value: "http://x/v1" } })
		fireEvent.change(screen.getByTestId("secret-openAiApiKey"), { target: { value: "sk-1" } })
		fireEvent.change(screen.getByTestId("model-id-input"), { target: { value: "m1" } })
	}
	beforeEach(() => {
		vi.clearAllMocks()
		host = createFakeHost()
		mocks.host = host.client
		mocks.state = { hideAccount: vi.fn(), hideSettings: vi.fn(), setShowWelcome: vi.fn(), modelSettings: host.state() }
		mocks.setWelcomeViewCompleted.mockResolvedValue({})
	})

	it("leaves a connection, a model, and Chat and Background text on it, so a fresh install can run", async () => {
		render(<OnboardingView />)
		fill()
		fireEvent.click(screen.getByText("Create"))
		await waitFor(() => expect(mocks.setWelcomeViewCompleted).toHaveBeenCalledWith(expect.objectContaining({ value: true })))

		const { settings } = host.state()
		const pick = { modelId: settings.models[0].id, levelId: "default" }
		expect(settings.connections[0]).toMatchObject({ kind: "openai-compatible", baseUrl: "http://x/v1" })
		expect(settings.models[0].upstreamId).toBe("m1")
		expect(settings.roles.chat).toEqual(pick)
		expect(settings.roles.background.pick).toEqual(pick)
		expect(host.secrets[`settings:v1:connection:${settings.connections[0].id}:apiKey`]).toBe("sk-1")
		expect(mocks.saveApiProfile).not.toHaveBeenCalled()
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		expect(mocks.updateSettings).not.toHaveBeenCalled()
		expect(mocks.state.setShowWelcome).toHaveBeenCalledWith(false)
	})

	it("Ask runs on it too when Ask has its own role on", async () => {
		const settings = createDefaultModelSettings()
		settings.roles.ask.enabled = true
		host = createFakeHost({ settings })
		mocks.host = host.client
		mocks.state = { ...mocks.state, modelSettings: host.state() }
		render(<OnboardingView />)
		fill()
		fireEvent.click(screen.getByText("Create"))
		await waitFor(() => expect(mocks.setWelcomeViewCompleted).toHaveBeenCalled())
		const { roles, models } = host.state().settings
		expect(roles.ask.pick?.modelId).toBe(models[0].id)
	})

	it("stays on the form when a step fails, and a retry doesn't add a second connection", async () => {
		const save = host.client.saveConfiguredModels
		mocks.host = { ...host.client, saveConfiguredModels: () => Promise.reject(new Error("no such model")) }
		render(<OnboardingView />)
		fill()
		fireEvent.click(screen.getByText("Create"))
		expect(await screen.findByText("no such model")).toBeTruthy()
		expect(mocks.setWelcomeViewCompleted).not.toHaveBeenCalled()
		expect(mocks.state.setShowWelcome).not.toHaveBeenCalled()

		mocks.host = { ...host.client, saveConfiguredModels: save }
		fireEvent.click(screen.getByText("Create"))
		await waitFor(() => expect(mocks.setWelcomeViewCompleted).toHaveBeenCalled())
		expect(host.state().settings.connections).toHaveLength(1)
		expect(host.state().settings.roles.chat).not.toBeNull()
	})

	it("a level the model doesn't offer is refused where it can be fixed, not saved as a pick that won't start", async () => {
		render(<OnboardingView />)
		fireEvent.change(screen.getByLabelText("API Provider"), { target: { value: "anthropic" } })
		fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-x" } })
		fireEvent.change(screen.getByTestId("secret-apiKey"), { target: { value: "sk-2" } })
		fireEvent.change(screen.getByLabelText("Default reasoning effort"), { target: { value: "high" } })
		fireEvent.click(screen.getByText("Create"))
		expect(await screen.findByText(/doesn't offer the high level/)).toBeTruthy()
		expect(host.state().settings.roles.chat).toBeNull()
		expect(mocks.setWelcomeViewCompleted).not.toHaveBeenCalled()
	})
})

describe("OnboardingView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.state = {
			hideAccount: vi.fn(),
			hideSettings: vi.fn(),
			setShowWelcome: vi.fn(),
		}
		mocks.saveApiProfile.mockImplementation(async (req: any) => ({ profile: { id: req.id || "saved-1" } }))
		mocks.assignApiProfile.mockResolvedValue({})
		mocks.updateSettings.mockResolvedValue({})
		mocks.setWelcomeViewCompleted.mockResolvedValue({})
	})

	it("only offers the allowed providers", () => {
		render(<OnboardingView />)
		const provider = screen.getByLabelText("API Provider") as HTMLSelectElement
		expect(Array.from(provider.options).map((option) => option.value)).toEqual([
			"openai",
			"bedrock",
			"anthropic",
			"openai-native",
		])
	})

	it("saves a configuration and assigns it to Ask and Act", async () => {
		render(<OnboardingView />)
		fireEvent.change(screen.getByTestId("option-openAiBaseUrl"), { target: { value: "http://x/v1" } })
		fireEvent.change(screen.getByTestId("secret-openAiApiKey"), { target: { value: "sk-1" } })
		fireEvent.change(screen.getByTestId("model-id-input"), { target: { value: "m1" } })
		fireEvent.click(screen.getByText("Create"))

		await waitFor(() => expect(mocks.assignApiProfile).toHaveBeenCalledTimes(2))
		const request = mocks.saveApiProfile.mock.calls[0][0]
		expect(request).toMatchObject({ provider: "openai", modelId: "m1" })
		expect(JSON.parse(request.optionsJson)).toEqual({ openAiBaseUrl: "http://x/v1" })
		expect(request.secrets).toEqual({ openAiApiKey: "sk-1" })
		expect(mocks.assignApiProfile.mock.calls.map((call) => call[0])).toEqual([
			expect.objectContaining({ mode: "plan", profileId: "saved-1" }),
			expect.objectContaining({ mode: "act", profileId: "saved-1" }),
		])
		await waitFor(() => expect(mocks.setWelcomeViewCompleted).toHaveBeenCalledWith(expect.objectContaining({ value: true })))
	})

	it("blocks completion when the provider is missing required config", async () => {
		render(<OnboardingView />)
		fireEvent.change(screen.getByLabelText("API Provider"), { target: { value: "anthropic" } })
		fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-x" } })
		fireEvent.click(screen.getByText("Create"))

		expect(await screen.findByText("An API key is required for Anthropic.")).toBeTruthy()
		expect(mocks.saveApiProfile).not.toHaveBeenCalled()
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
	})

	it("never touches the cline/cline-pass providers", async () => {
		render(<OnboardingView />)
		fireEvent.change(screen.getByTestId("option-openAiBaseUrl"), { target: { value: "http://x/v1" } })
		fireEvent.change(screen.getByTestId("secret-openAiApiKey"), { target: { value: "sk-1" } })
		fireEvent.change(screen.getByTestId("model-id-input"), { target: { value: "m1" } })
		fireEvent.click(screen.getByText("Create"))

		await waitFor(() => expect(mocks.saveApiProfile).toHaveBeenCalled())
		for (const call of [...mocks.saveApiProfile.mock.calls, ...mocks.assignApiProfile.mock.calls]) {
			expect(JSON.stringify(call)).not.toMatch(/cline(-pass)?/)
		}
	})
})
