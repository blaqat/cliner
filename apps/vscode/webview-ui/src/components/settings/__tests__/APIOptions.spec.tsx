import { ApiConfiguration } from "@shared/api"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ExtensionStateContextProvider, useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderListings } from "@/hooks/useProviderListings"
import ApiOptions from "../ApiOptions"

vi.mock("@/hooks/useProviderListings", () => ({
	useProviderListings: vi.fn(() => ({ providers: [], isLoading: false, error: undefined, refresh: vi.fn() })),
}))

vi.mock("../providers/GenericProviderSettings", () => ({
	GenericProviderSettings: vi.fn((props) => <div data-testid="generic-provider-settings">{props.providerName}</div>),
}))

// ClinePassHint pulls in useClinePassPromo (auth context, grpc clients); these
// tests exercise provider forms, so keep the promo surface inert.
vi.mock("@/hooks/useClinePassPromo", () => ({
	CLINE_PASS_PROVIDER_ID: "cline-pass",
	useClinePassPromo: vi.fn(() => ({ isClinePassEnabled: false })),
}))

const mockProviderListings = (
	providers: Array<{ id: string; name: string; protocol: string; allowsCustomModelIds: boolean }>,
) => {
	vi.mocked(useProviderListings).mockReturnValue({ providers, isLoading: false, error: undefined, refresh: vi.fn() })
}

vi.mock("../../../context/ExtensionStateContext", async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...(actual || {}),
		// your mocked methods
		useExtensionState: vi.fn(() => ({
			apiConfiguration: {
				planModeApiProvider: "anthropic",
				actModeApiProvider: "anthropic",
			},
			setApiConfiguration: vi.fn(),
			planActSeparateModelsSetting: false,
		})),
	}
})

const mockExtensionState = (apiConfiguration: Partial<ApiConfiguration>) => {
	vi.mocked(useExtensionState).mockReturnValue({
		apiConfiguration,
		setApiConfiguration: vi.fn(),
		planActSeparateModelsSetting: false,
		// Provider model-list context read by useProviderModels. Static-list
		// providers render their model <select> from this map, so seed the
		// providers exercised here with the model id each test expects.
		providerModelsByProvider: {},
		startProviderModelsRequest: vi.fn(),
		applyProviderModelsResponse: vi.fn(),
	} as any)
}

describe("ApiOptions provider allowlist", () => {
	const mockPostMessage = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: mockPostMessage }
		mockExtensionState({
			planModeApiProvider: "anthropic",
			actModeApiProvider: "anthropic",
		})
	})

	it("lists only the allowed providers in the picker", () => {
		mockProviderListings([
			{ id: "openai-compatible", name: "OpenAI Compatible", protocol: "openai-chat", allowsCustomModelIds: true },
			{ id: "bedrock", name: "Amazon Bedrock", protocol: "anthropic", allowsCustomModelIds: false },
			{ id: "anthropic", name: "Anthropic", protocol: "anthropic", allowsCustomModelIds: false },
			{ id: "openai-native", name: "OpenAI", protocol: "openai-responses", allowsCustomModelIds: false },
			{ id: "requesty", name: "Requesty", protocol: "openai-chat", allowsCustomModelIds: true },
			{ id: "openrouter", name: "OpenRouter", protocol: "openai-chat", allowsCustomModelIds: true },
		])

		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)

		fireEvent.focus(screen.getByTestId("provider-selector-input"))

		expect(screen.getByTestId("provider-option-openai-compatible")).toBeInTheDocument()
		expect(screen.getByTestId("provider-option-bedrock")).toBeInTheDocument()
		expect(screen.getByTestId("provider-option-anthropic")).toBeInTheDocument()
		expect(screen.getByTestId("provider-option-openai-native")).toBeInTheDocument()
		expect(screen.queryByTestId("provider-option-requesty")).not.toBeInTheDocument()
		expect(screen.queryByTestId("provider-option-openrouter")).not.toBeInTheDocument()
	})

	it("maps a stored disallowed provider to the first allowed provider", () => {
		mockProviderListings([
			{ id: "openai-compatible", name: "OpenAI Compatible", protocol: "openai-chat", allowsCustomModelIds: true },
		])
		mockExtensionState({
			planModeApiProvider: "requesty" as any,
			actModeApiProvider: "requesty" as any,
		})

		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)

		// "requesty" is not allowed, so the UI falls back to the first allowed
		// provider ("openai", the OpenAI Compatible form).
		expect(screen.getByText("Base URL")).toBeInTheDocument()
		expect(screen.getByText("API Type")).toBeInTheDocument()
	})

	it("renders the dedicated form for an allowed provider", () => {
		mockExtensionState({
			planModeApiProvider: "openai-native",
			actModeApiProvider: "openai-native",
		})

		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={false} />
			</ExtensionStateContextProvider>,
		)

		expect(screen.getByText("OpenAI API Key")).toBeInTheDocument()
		expect(screen.queryByText("Custom Headers")).not.toBeInTheDocument()
	})
})

describe("OpenApiInfoOptions", () => {
	const mockPostMessage = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: mockPostMessage }
		mockExtensionState({
			planModeApiProvider: "openai",
			actModeApiProvider: "openai",
		})
	})

	it("renders the API type selector for the OpenAI Compatible provider", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)
		expect(screen.getByText("API Type")).toBeInTheDocument()
	})

	it("renders OpenAI Supports Images input", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)
		fireEvent.click(screen.getByText("Model Configuration"))
		const apiKeyInput = screen.getByText("Supports Images")
		expect(apiKeyInput).toBeInTheDocument()
	})

	it("renders OpenAI Context Window Size input", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)
		fireEvent.click(screen.getByText("Model Configuration"))
		const orgIdInput = screen.getByText("Context Window Size")
		expect(orgIdInput).toBeInTheDocument()
	})

	it("renders OpenAI Max Output Tokens input", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)
		fireEvent.click(screen.getByText("Model Configuration"))
		const modelInput = screen.getByText("Max Output Tokens")
		expect(modelInput).toBeInTheDocument()
	})
})
