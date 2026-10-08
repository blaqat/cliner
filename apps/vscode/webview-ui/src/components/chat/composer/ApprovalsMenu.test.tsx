import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ApprovalsMenu, { summarizeApprovals } from "./ApprovalsMenu"

const mocks = vi.hoisted(() => ({
	updateAutoApprovalSettings: vi.fn(async () => ({})),
	settings: undefined as unknown,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ autoApprovalSettings: mocks.settings }),
}))

vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateAutoApprovalSettings: mocks.updateAutoApprovalSettings },
}))

const ALL_ON = {
	...DEFAULT_AUTO_APPROVAL_SETTINGS,
	actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, executeSafeCommands: true },
}

describe("ApprovalsMenu", () => {
	beforeEach(() => {
		mocks.settings = DEFAULT_AUTO_APPROVAL_SETTINGS
		mocks.updateAutoApprovalSettings.mockClear()
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("counts enabled approval types from the menu's actions", () => {
		// Defaults: read, edit, web fetch, MCP on; commands off.
		expect(summarizeApprovals(DEFAULT_AUTO_APPROVAL_SETTINGS)).toEqual({ enabledCount: 4, total: 5, approveAll: false })
		expect(summarizeApprovals(ALL_ON)).toEqual({ enabledCount: 5, total: 5, approveAll: true })
	})

	it("shows the count on the shield button", () => {
		render(<ApprovalsMenu />)
		const button = screen.getByTestId("approvals-button")
		expect(screen.getByTestId("approvals-count")).toHaveTextContent("4")
		expect(button).toHaveAttribute("data-approve-all", "false")
		expect(button).toHaveAccessibleName("Auto-approve: 4 types on")
		expect(button).not.toHaveClass("text-error")
	})

	it("turns to the warning state when everything is auto-approved (YOLO)", () => {
		mocks.settings = ALL_ON
		render(<ApprovalsMenu />)
		const button = screen.getByTestId("approvals-button")
		expect(button).toHaveAttribute("data-approve-all", "true")
		expect(button).toHaveClass("text-error")
		expect(button).toHaveAccessibleName("Auto-approve: everything runs without asking")
		fireEvent.click(button)
		expect(screen.getByTestId("approvals-all-warning")).toBeInTheDocument()
	})

	it("opens the same options and toggles them through the existing settings RPC", () => {
		render(<ApprovalsMenu />)
		fireEvent.click(screen.getByTestId("approvals-button"))
		const menu = screen.getByTestId("approvals-menu")
		for (const label of ["Read files", "Edit files", "Execute commands", "Fetch web content", "Use MCP servers"]) {
			expect(menu).toHaveTextContent(label)
		}
		fireEvent.click(screen.getByText("Execute commands"))
		expect(mocks.updateAutoApprovalSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				version: DEFAULT_AUTO_APPROVAL_SETTINGS.version + 1,
				actions: expect.objectContaining({ executeSafeCommands: true }),
			}),
		)
	})
})

describe("old auto-approve bar", () => {
	it("is removed from the codebase", () => {
		expect(Object.keys(import.meta.glob("../auto-approve-menu/AutoApproveBar.tsx"))).toHaveLength(0)
		expect(Object.keys(import.meta.glob("../auto-approve-menu/AutoApproveModal.tsx"))).toHaveLength(0)
	})
})
