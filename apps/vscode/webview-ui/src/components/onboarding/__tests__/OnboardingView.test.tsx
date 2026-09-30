import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import OnboardingView from "../OnboardingView"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	saveApiProfile: vi.fn(),
	assignApiProfile: vi.fn(),
	updateSettings: vi.fn(),
	setWelcomeViewCompleted: vi.fn(),
	captureOnboardingProgress: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		saveApiProfile: mocks.saveApiProfile,
		assignApiProfile: mocks.assignApiProfile,
	},
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
