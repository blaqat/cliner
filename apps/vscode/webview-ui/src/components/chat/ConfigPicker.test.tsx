import { fireEvent, render, screen } from "@testing-library/react"
import type React from "react"
import { createContext, useContext } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ConfigPicker, { MANAGE_CONFIGURATIONS_VALUE } from "./ConfigPicker"
import ReasoningEffortPicker from "./ReasoningEffortPicker"

const mocks = vi.hoisted(() => ({
	assignApiProfile: vi.fn(),
	handleFieldChange: vi.fn().mockResolvedValue({}),
	writeProviderConfig: vi.fn(),
	saveApiProfile: vi.fn(),
	navigateToSettings: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ ...mocks.state, navigateToSettings: mocks.navigateToSettings }),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		assignApiProfile: (request: unknown) => mocks.assignApiProfile(request),
		writeProviderConfig: mocks.writeProviderConfig,
		saveApiProfile: mocks.saveApiProfile,
	},
}))

vi.mock("@/components/settings/utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldChange: mocks.handleFieldChange }),
}))

// Radix Select does not open in jsdom; a flat stand-in keeps the picker's own logic under test.
vi.mock("@/components/ui/select", () => {
	const ValueContext = createContext<{ value: string; onValueChange: (value: string) => void }>({
		value: "",
		onValueChange: () => {},
	})
	return {
		Select: ({
			value,
			onValueChange,
			children,
		}: {
			value: string
			onValueChange: (v: string) => void
			children: React.ReactNode
		}) => <ValueContext.Provider value={{ value, onValueChange }}>{children}</ValueContext.Provider>,
		SelectTrigger: ({ children, ...props }: { children: React.ReactNode }) => (
			<div data-testid="config-picker" {...props}>
				{children}
			</div>
		),
		SelectValue: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
		SelectContent: ({ children }: { children: React.ReactNode }) => <div role="listbox">{children}</div>,
		SelectSeparator: () => <hr />,
		SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
			const context = useContext(ValueContext)
			return (
				<button
					aria-selected={context.value === value}
					onClick={() => context.onValueChange(value)}
					role="option"
					type="button">
					{children}
				</button>
			)
		},
	}
})

const profiles = [
	{ id: "p1", name: "Claude work", provider: "anthropic", modelId: "claude-sonnet" },
	{ id: "p2", name: "Local vLLM", provider: "openai", modelId: "qwen" },
]

describe("ConfigPicker", () => {
	beforeEach(() => {
		mocks.assignApiProfile.mockReset().mockResolvedValue({})
		mocks.navigateToSettings.mockReset()
		mocks.state = { apiConfigProfiles: profiles, askProfileId: "p2", actProfileId: "p1" }
	})

	it("lists saved configuration names and marks the one assigned to the mode", () => {
		render(<ConfigPicker fallbackLabel="anthropic:claude-sonnet" mode="plan" />)

		const options = screen.getAllByRole("option")
		expect(options.map((option) => option.textContent)).toEqual(["Claude work", "Local vLLM", "Manage configurations…"])
		expect(screen.getByRole("option", { name: "Local vLLM" })).toHaveAttribute("aria-selected", "true")
		expect(screen.getByTestId("config-picker")).toHaveTextContent("Local vLLM")
	})

	it("assigns the picked configuration to the current mode", () => {
		render(<ConfigPicker fallbackLabel="x" mode="act" />)

		fireEvent.click(screen.getByRole("option", { name: "Local vLLM" }))

		expect(mocks.assignApiProfile).toHaveBeenCalledWith(expect.objectContaining({ mode: "act", profileId: "p2" }))
	})

	it("does not reassign the current configuration", () => {
		render(<ConfigPicker fallbackLabel="x" mode="act" />)
		fireEvent.click(screen.getByRole("option", { name: "Claude work" }))
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
	})

	it("opens the API settings tab from Manage configurations", () => {
		render(<ConfigPicker fallbackLabel="x" mode="plan" />)

		fireEvent.click(screen.getByRole("option", { name: "Manage configurations…" }))

		expect(mocks.navigateToSettings).toHaveBeenCalledWith("api-config")
		expect(mocks.assignApiProfile).not.toHaveBeenCalledWith(
			expect.objectContaining({ profileId: MANAGE_CONFIGURATIONS_VALUE }),
		)
	})

	it("falls back to the model label when nothing is assigned", () => {
		mocks.state = { apiConfigProfiles: [] }
		render(<ConfigPicker fallbackLabel="anthropic:claude-sonnet" mode="plan" />)

		expect(screen.getByTestId("config-picker")).toHaveTextContent("anthropic:claude-sonnet")
		expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Manage configurations…"])
	})
})

describe("ReasoningEffortPicker", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.state = {
			apiConfiguration: { planModeReasoningEffort: "low", actModeReasoningEffort: "high" },
			planActSeparateModelsSetting: false,
		}
	})

	it.each(["plan", "act"] as const)("updates only %s effort without saving provider or profile settings", (mode) => {
		render(<ReasoningEffortPicker mode={mode} modelId="m" modelInfo={{ supportsReasoning: true }} provider="anthropic" />)
		fireEvent.click(screen.getByRole("option", { name: "Xhigh" }))
		expect(mocks.handleFieldChange).toHaveBeenCalledExactlyOnceWith(`${mode}ModeReasoningEffort`, "xhigh")
		expect(mocks.writeProviderConfig).not.toHaveBeenCalled()
		expect(mocks.saveApiProfile).not.toHaveBeenCalled()
	})

	it("shows provider default for an assigned profile with unset effective effort", () => {
		mocks.state = { apiConfiguration: {}, actProfileId: "p1" }
		render(
			<ReasoningEffortPicker
				defaultEffort="medium"
				mode="act"
				modelId="m"
				modelInfo={{ supportsReasoning: true }}
				provider="openai-native"
			/>,
		)
		expect(screen.getByRole("option", { name: "Provider default" })).toHaveAttribute("aria-selected", "true")
	})

	it("can return to provider default", () => {
		render(<ReasoningEffortPicker mode="act" modelId="m" modelInfo={{ supportsReasoning: true }} provider="openai" />)
		fireEvent.click(screen.getByRole("option", { name: "Provider default" }))
		expect(mocks.handleFieldChange).toHaveBeenCalledWith("actModeReasoningEffort", "none")
	})
})
