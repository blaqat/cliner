import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import FeatureSettingsSection from "./FeatureSettingsSection"

const mockUpdateSetting = vi.fn()
const mockExtensionState = vi.hoisted(() => ({
	value: {
		enableCheckpointsSetting: true,
		hooksEnabled: false,
		showFeatureTips: false,
		mcpDisplayMode: "rich",
		useAutoCondense: false,
		compactionStrategy: "basic",
		subagentsEnabled: false,
		worktreesEnabled: { user: true, featureFlag: true },
		focusChainSettings: { enabled: false, remindClineInterval: 6 },
		remoteConfigSettings: {},
		backgroundEditEnabled: false,
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => mockExtensionState.value),
}))

vi.mock("@/components/settings/utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

describe("FeatureSettingsSection", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = {
			...mockExtensionState.value,
			useAutoCondense: false,
			compactionStrategy: "basic",
		}
	})

	it("renders Hooks feature toggle", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Hooks")).toBeTruthy()

		const advancedSection = container.querySelector("#advanced-features")
		const agentSection = container.querySelector("#agent-features")

		expect(advancedSection?.querySelector("#hooks-setting-control")).toBeTruthy()
		expect(agentSection?.querySelector("#hooks-setting-control")).toBeNull()
	})

	it("renders Feature Tips toggle in the Editor section", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Feature Tips")).toBeTruthy()

		const editorSection = container.querySelector("#optional-features")
		const agentSection = container.querySelector("#agent-features")

		expect(editorSection?.querySelector("#show-feature-tips-setting-control")).toBeTruthy()
		expect(agentSection?.querySelector("#show-feature-tips-setting-control")).toBeNull()
	})

	it("renders the Auto Compact Strategy setting in the Agent section", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Auto Compact Strategy")).toBeTruthy()

		const agentSection = container.querySelector("#agent-features")
		expect(agentSection?.textContent).toContain("Basic")
	})

	it("disables Auto Compact Strategy when Auto Compact is off", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const strategySelect = container.querySelector("#agent-features button[role='combobox']")
		expect(strategySelect).toHaveAttribute("disabled")
	})

	it("calls updateSetting with hooksEnabled when toggled", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Hooks" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("hooksEnabled", true)
	})

	it("calls updateSetting with showFeatureTips when toggled", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Feature Tips" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("showFeatureTips", true)
	})

	it("turns in-app toasts off and on", () => {
		mockExtensionState.value = { ...mockExtensionState.value, threadToastsEnabled: true, threadToastSeconds: 5 } as never
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "In-app Toasts" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("threadToastsEnabled", false)
	})

	it("saves the completion toast duration on blur and ignores invalid values", () => {
		mockExtensionState.value = { ...mockExtensionState.value, threadToastsEnabled: true, threadToastSeconds: 5 } as never
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)
		const input = screen.getByTestId("thread-toast-seconds") as HTMLInputElement
		expect(input.value).toBe("5")

		fireEvent.change(input, { target: { value: "0" } })
		fireEvent.blur(input)
		expect(mockUpdateSetting).not.toHaveBeenCalled()
		expect(input.value).toBe("5")

		fireEvent.change(input, { target: { value: "9" } })
		fireEvent.blur(input)
		expect(mockUpdateSetting).toHaveBeenCalledWith("threadToastSeconds", 9)
	})

	it("disables the duration while toasts are off", () => {
		mockExtensionState.value = { ...mockExtensionState.value, threadToastsEnabled: false } as never
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByTestId("thread-toast-seconds")).toBeDisabled()
	})
})
