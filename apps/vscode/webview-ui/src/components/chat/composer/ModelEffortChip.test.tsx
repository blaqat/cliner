import { type AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { SETTINGS_LOCK_HELD_CAUSE } from "@shared/model-settings-migration-status"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
import ModelEffortChip, { NEXT_MESSAGE_TIPS } from "./ModelEffortChip"

const mocks = vi.hoisted(() => ({
	assignApiProfile: vi.fn(),
	updateAutoApprovalSettings: vi.fn(),
	navigateToSettings: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ ...mocks.state, navigateToSettings: mocks.navigateToSettings }),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { assignApiProfile: (request: unknown) => mocks.assignApiProfile(request) },
	StateServiceClient: { updateAutoApprovalSettings: (request: unknown) => mocks.updateAutoApprovalSettings(request) },
}))

const FULL: AutoApprovalSettings = {
	...DEFAULT_AUTO_APPROVAL_SETTINGS,
	actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, executeSafeCommands: true },
}

const renderChip = (props: Partial<React.ComponentProps<typeof ModelEffortChip>> = {}) =>
	render(<ModelEffortChip fallbackLabel="claude-sonnet" mode="act" {...props} />)

const chip = () => screen.getByTestId("model-effort-chip")
const options = (column: HTMLElement) => within(column).getAllByRole("option")
const selected = (column: HTMLElement) => within(column).getByRole("option", { selected: true })
const modelColumn = () => screen.getByTestId("model-list")
const effortColumn = () => screen.getByTestId("effort-list")
const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

async function openMenu() {
	fireEvent.click(chip())
	const menu = await screen.findByTestId("model-menu")
	// Radix starts listening for outside clicks a tick after it opens.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
	return menu
}

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class ResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	mocks.assignApiProfile.mockReset().mockResolvedValue({})
	mocks.updateAutoApprovalSettings.mockReset().mockResolvedValue({})
	mocks.navigateToSettings.mockReset()
	mocks.state = {
		modelSettings: modelSettingsFixture(),
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
	}
})

describe("ModelEffortChip", () => {
	describe("before the setup has moved", () => {
		beforeEach(() => {
			mocks.state = {
				autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
				currentTaskItem: { id: "chat" },
				// What the old runtime still publishes must not come back as a choice.
				apiConfigProfiles: [{ id: "p1", name: "Old profile", provider: "anthropic", modelId: "claude" }],
				actProfileId: "p1",
			}
		})

		it("names what's running, and offers no choice and no old RPC", async () => {
			renderChip()
			expect(chip()).toHaveTextContent(/^claude-sonnet$/)
			expect(chip().title).toContain("Running on your last selection")
			const menu = await openMenu()
			expect(within(menu).queryByRole("option", { name: /Old profile/ })).toBeNull()
			expect(within(menu).queryByTestId("menu-make-default")).toBeNull()
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		})

		it("says why and links to Settings, where the retry is", async () => {
			renderChip()
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Running on your last selection")
			fireEvent.click(screen.getByTestId("model-menu-fix"))
			expect(mocks.navigateToSettings).toHaveBeenCalledWith("models")
		})

		it("doesn't claim it's running on the last selection while another window holds the lock", async () => {
			mocks.state.modelSettingsMigrationStatus = { status: "failed", retryable: true, cause: SETTINGS_LOCK_HELD_CAUSE }
			renderChip()
			expect(chip().title).toContain("Another window is using settings")
			expect(chip().title).not.toContain("last selection")
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Another window is using settings")
		})

		it("leaves the approval tiles working", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("approval-readFiles"))
			expect(mocks.updateAutoApprovalSettings).toHaveBeenCalledOnce()
		})

		it("keeps Reset and Next message only off, saying why", async () => {
			renderChip()
			await openMenu()
			expect(screen.getByTestId("menu-reset")).toBeDisabled()
			expect(screen.getByTestId("menu-reset").title).toMatch(/come back once/)
			expect(screen.getByTestId("menu-next-message")).toBeDisabled()
		})
	})

	describe("the chip", () => {
		it("is one button reading Model Effort as words (no · or +)", () => {
			renderChip()
			expect(chip().tagName).toBe("BUTTON")
			expect(chip()).toHaveTextContent(/^GPT-6 Sol · Company gatewayMed$/)
			expect(chip().textContent).not.toMatch(/[+]/)
			expect(chip()).toHaveAccessibleName("Act model: GPT-6 Sol · Company gateway, effort Medium; Auto-approve: 4 of 5")
			expect(screen.queryByTestId("full-access-icon")).toBeNull()
			// No separate model / effort click targets any more.
			expect(within(chip()).queryAllByRole("button")).toHaveLength(0)
		})

		it("brightens its text on hover: no background highlight, a focus ring for keyboards", () => {
			renderChip()
			expect(chip()).toHaveClass("hover:text-foreground", "focus-visible:text-foreground", "bg-transparent")
			expect(chip().className).not.toMatch(/hover:bg-/)
			expect(chip().className).toContain("focus-visible:outline-(--vscode-focusBorder)")
		})

		it("hides the effort word on a narrow row, but still names it", () => {
			renderChip({ compactEffort: true })
			expect(chip()).toHaveTextContent(/^GPT-6 Sol · Company gateway$/)
			expect(screen.queryByTestId("chip-effort")).toBeNull()
			expect(chip()).toHaveAccessibleName(/effort Medium/)
		})

		it("with every action auto-approved, puts the error-colored shield before the text", () => {
			mocks.state.autoApprovalSettings = FULL
			renderChip()
			const icon = screen.getByTestId("full-access-icon")
			expect(icon).toHaveClass("text-error")
			expect(icon.compareDocumentPosition(screen.getByTestId("chip-model")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
			expect(chip()).toHaveAccessibleName(/Auto-approve: all/)
		})
	})

	describe("the menu", () => {
		it("opens from a click on the chip: the tiles, lists, then footer", async () => {
			renderChip()
			const menu = await openMenu()
			expect(chip()).toHaveAttribute("aria-expanded", "true")
			expect(menu).toHaveClass("bg-menu", "border", "shadow-md")
			const order = [
				within(menu).getByTestId("approval-tiles"),
				within(menu).getByTestId("model-effort-lists"),
				within(menu).getByTestId("menu-reset"),
				within(menu).getByTestId("menu-models-page"),
			]
			for (let i = 1; i < order.length; i++) expect(follows(order[i - 1], order[i])).toBe(true)
			// The tiles are the menu's first block.
			const blocks = [...menu.children].filter((child) => child.tagName === "DIV" || child.tagName === "HR")
			expect(blocks[0]).toContainElement(within(menu).getByTestId("approval-tiles"))
			// Focus lands on the model list.
			await waitFor(() => expect(modelColumn()).toHaveFocus())
			// A click on the chip again closes it.
			fireEvent.click(chip())
			expect(screen.queryByTestId("model-menu")).toBeNull()
		})
	})

	describe("approval tiles", () => {
		it("are five icon-only tiles with names and pressed state, and no count", async () => {
			renderChip()
			await openMenu()
			const tiles = within(screen.getByTestId("approval-tiles")).getAllByRole("button")
			expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
				"Read files",
				"Edit files",
				"Execute commands",
				"Fetch web content",
				"Use MCP servers",
			])
			for (const tile of tiles) expect(tile).toHaveTextContent(/^$/)
			// Defaults: everything but commands is on.
			expect(tiles.map((tile) => tile.getAttribute("aria-pressed"))).toEqual(["true", "true", "false", "true", "true"])
			expect(tiles[0]).toHaveClass("bg-(--vscode-focusBorder)/25", "text-foreground")
			expect(tiles[2]).toHaveClass("bg-code", "text-description")
			// The lit tiles say how many are on: no "4 of 5".
			expect(screen.getByTestId("approval-tiles")).not.toHaveTextContent(/of 5/)
			expect(screen.queryByTestId("approvals-count")).toBeNull()
			expect(screen.queryByTestId("approvals-all-on")).toBeNull()
		})

		it("each tile saves its own setting at once and keeps the menu open", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("approval-executeSafeCommands"))
			expect(mocks.updateAutoApprovalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					actions: expect.objectContaining({
						readFiles: true,
						editFiles: true,
						executeSafeCommands: true,
						useBrowser: true,
						useMcp: true,
					}),
				}),
			)
			fireEvent.click(screen.getByTestId("approval-useMcp"))
			expect(mocks.updateAutoApprovalSettings).toHaveBeenLastCalledWith(
				expect.objectContaining({ actions: expect.objectContaining({ useMcp: false }) }),
			)
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		})

		it("with all five on, the tiles stay blue and the heading gets an error-colored All on", async () => {
			mocks.state.autoApprovalSettings = FULL
			renderChip()
			await openMenu()
			const badge = screen.getByTestId("approvals-all-on")
			expect(badge).toHaveClass("text-error")
			expect(badge).toHaveTextContent("All on")
			expect(screen.queryByTestId("approvals-count")).toBeNull()
			for (const tile of within(screen.getByTestId("approval-tiles")).getAllByRole("button")) {
				expect(tile).toHaveAttribute("aria-pressed", "true")
				expect(tile).toHaveClass("bg-(--vscode-focusBorder)/25")
				expect(tile.className).not.toContain("text-error")
			}
		})
	})

	describe("footer and locked states", () => {
		it("Next message only is a switch that shows off and on at a glance, with a tooltip", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			await openMenu()
			const toggle = screen.getByRole("switch", { name: "Next message only" })
			expect(toggle).toBe(screen.getByTestId("menu-next-message"))
			expect(toggle).toHaveAttribute("aria-checked", "false")
			expect(toggle).toHaveAttribute("data-state", "off")
			expect(toggle).toHaveAttribute("title", NEXT_MESSAGE_TIPS.off)
			expect(screen.getByTestId("next-message-thumb")).not.toHaveClass("translate-x-[10px]")
		})

		it("has no Next message only before there's a chat", async () => {
			renderChip()
			await openMenu()
			expect(screen.queryByTestId("menu-next-message")).toBeNull()
		})
	})
})
