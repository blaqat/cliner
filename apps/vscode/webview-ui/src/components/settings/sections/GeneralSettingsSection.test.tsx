import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import GeneralSettingsSection from "./GeneralSettingsSection"

const mocks = vi.hoisted(() => ({ updateSetting: vi.fn(), enterSendsAs: "steer", platform: "win32" }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		telemetrySetting: "enabled",
		remoteConfigSettings: {},
		enterSendsAs: mocks.enterSendsAs,
		platform: mocks.platform,
	}),
}))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: mocks.updateSetting }))
vi.mock("../PreferredLanguageSetting", () => ({ default: () => null }))
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipContent: () => null,
	TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
	VSCodeLink: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
	VSCodeRadioGroup: ({ children, onChange }: any) => (
		<div
			onClick={(e) => {
				const value = (e.target as HTMLElement).getAttribute("data-value")
				if (value) {
					onChange({ target: { value } })
				}
			}}>
			{children}
		</div>
	),
	VSCodeRadio: ({ children, value }: any) => <span data-value={value}>{children}</span>,
}))

describe("GeneralSettingsSection", () => {
	beforeEach(() => vi.clearAllMocks())

	it("persists Enter sends as", () => {
		render(<GeneralSettingsSection renderSectionHeader={() => null} />)
		fireEvent.click(screen.getByText("Interject"))
		expect(mocks.updateSetting).toHaveBeenCalledWith("enterSendsAs", "interject")
	})

	it("labels the mod key per platform", () => {
		mocks.platform = "win32"
		const { unmount } = render(<GeneralSettingsSection renderSectionHeader={() => null} />)
		expect(screen.getByText(/Ctrl\+Enter does the other one\. Alt\+Enter sends as an aside\./)).toBeTruthy()
		unmount()

		mocks.platform = "darwin"
		render(<GeneralSettingsSection renderSectionHeader={() => null} />)
		expect(screen.getByText(/⌘\+Enter does the other one\. ⌥\+Enter sends as an aside\./)).toBeTruthy()
	})
})
