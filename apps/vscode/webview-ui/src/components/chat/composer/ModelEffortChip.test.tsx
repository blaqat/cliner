import { type AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ModelEffortChip, { LOCKED_REASON, NEXT_MESSAGE_TIPS, RESET_DISABLED_REASON } from "./ModelEffortChip"

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

const profiles = [
	{ id: "p1", name: "Claude work", provider: "anthropic", modelId: "claude-sonnet" },
	{ id: "p2", name: "Local vLLM", provider: "openai", modelId: "qwen" },
	{ id: "p3", name: "Opus 4.5", provider: "anthropic", modelId: "claude-opus", reasoningEffort: "medium" },
]

const FULL: AutoApprovalSettings = {
	...DEFAULT_AUTO_APPROVAL_SETTINGS,
	actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, executeSafeCommands: true },
}

const renderChip = (props: Partial<React.ComponentProps<typeof ModelEffortChip>> = {}) =>
	render(
		<ModelEffortChip
			fallbackLabel="anthropic:claude-sonnet"
			mode="act"
			modelId="m"
			modelInfo={{ supportsReasoning: true }}
			{...props}
		/>,
	)

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
		apiConfigProfiles: profiles,
		actProfileId: "p1",
		askProfileId: "p2",
		apiConfiguration: { actModeReasoningEffort: "high" },
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
	}
})

describe("ModelEffortChip", () => {
	describe("with the new model settings absent", () => {
		it("has no Make this the default line, no connection headings and no new RPCs", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			const menu = await openMenu()
			expect(within(menu).queryByTestId("menu-make-default")).toBeNull()
			expect(within(menu).queryByTestId("list-group")).toBeNull()
			expect(within(menu).queryByTestId("model-menu-empty")).toBeNull()
			// The mocked client has only the old RPC: anything else would throw.
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ mode: "act", taskId: "chat", profileId: "p2" }),
			)
		})
	})

	describe("the chip", () => {
		it("is one button reading Model Effort as words (no · or +)", () => {
			renderChip()
			expect(chip().tagName).toBe("BUTTON")
			expect(chip()).toHaveTextContent(/^Claude workHigh$/)
			expect(chip().textContent).not.toMatch(/[·+]/)
			expect(chip()).toHaveAccessibleName("Act model: Claude work, effort High; Auto-approve: 4 of 5")
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
			expect(chip()).toHaveTextContent(/^Claude work$/)
			expect(screen.queryByTestId("chip-effort")).toBeNull()
			expect(chip()).toHaveAccessibleName(/effort High/)
		})

		it("shows the running model's pending change", () => {
			mocks.state.composerApiSelection = { actProfileId: "p2" }
			mocks.state.focusedSessionModels = { act: { profileId: "p1", provider: "anthropic", modelId: "claude-sonnet" } }
			renderChip()
			expect(screen.getByTestId("chip-model").parentElement).toHaveTextContent("Local vLLM(pending)")
			expect(chip().title).toContain("Act currently uses anthropic:claude-sonnet")
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

		it("stays inside the viewport with one scroll region holding both lists", async () => {
			renderChip()
			const menu = await openMenu()
			expect(menu).toHaveClass("max-h-(--radix-popover-content-available-height)", "flex", "flex-col")
			const scroll = screen.getByTestId("model-menu-scroll")
			expect(scroll).toHaveClass("overflow-y-auto", "min-h-0")
			expect(scroll).toContainElement(modelColumn())
			expect(scroll).toContainElement(effortColumn())
			// The columns never scroll on their own.
			for (const column of [modelColumn(), effortColumn()]) {
				expect(column.className).not.toMatch(/overflow-(y-)?(auto|scroll|hidden)/)
			}
			// No wheel: nothing slides, nothing is masked.
			expect(screen.queryByTestId("double-wheel")).toBeNull()
			expect(scroll.querySelector("[style*=translate]")).toBeNull()
		})

		it("lists every model and effort, banding the chosen ones", async () => {
			renderChip()
			await openMenu()
			expect(options(modelColumn()).map((option) => option.textContent)).toEqual(["Claude work", "Local vLLM", "Opus 4.5"])
			expect(options(modelColumn())[0]).toHaveAttribute("title", "Claude work · claude-sonnet")
			expect(selected(modelColumn())).toHaveTextContent("Claude work")
			expect(options(effortColumn()).map((option) => option.textContent)).toEqual([
				"Default",
				"Low",
				"Medium",
				"High",
				"XHigh",
			])
			expect(options(effortColumn())[0]).toHaveAttribute("title", "Default · Provider default")
			expect(selected(effortColumn())).toHaveTextContent("High")
			expect(selected(modelColumn())).toHaveClass("bg-selection", "text-selection-foreground")
			expect(selected(effortColumn())).toHaveClass("bg-selection", "text-selection-foreground")
			for (const option of options(effortColumn()).filter((o) => o.getAttribute("aria-selected") !== "true")) {
				expect(option).not.toHaveClass("bg-selection")
			}
		})

		it("right-aligns the models and left-aligns the efforts, so they meet in the middle", async () => {
			renderChip()
			await openMenu()
			expect(modelColumn()).toHaveAttribute("data-align", "end")
			expect(effortColumn()).toHaveAttribute("data-align", "start")
			for (const option of options(modelColumn())) expect(option).toHaveClass("text-right")
			for (const option of options(effortColumn())) expect(option).toHaveClass("text-left")
			expect(follows(modelColumn(), effortColumn())).toBe(true)
		})

		it("↑/↓ move the focused column, ←/→ switch columns, Enter keeps both in one request", async () => {
			renderChip()
			await openMenu()
			await waitFor(() => expect(modelColumn()).toHaveFocus())
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			expect(selected(modelColumn())).toHaveTextContent("Local vLLM")
			// The effort column is untouched by the model column's keys (Local vLLM brings its own: Default).
			expect(selected(effortColumn())).toHaveTextContent("Default")
			fireEvent.keyDown(modelColumn(), { key: "ArrowRight" })
			expect(effortColumn()).toHaveFocus()
			expect(effortColumn()).toHaveAttribute("tabindex", "0")
			expect(modelColumn()).toHaveAttribute("tabindex", "-1")
			fireEvent.keyDown(effortColumn(), { key: "End" })
			fireEvent.keyDown(effortColumn(), { key: "ArrowUp" })
			expect(selected(effortColumn())).toHaveTextContent("High")
			expect(selected(modelColumn())).toHaveTextContent("Local vLLM")
			fireEvent.keyDown(effortColumn(), { key: "ArrowLeft" })
			expect(modelColumn()).toHaveFocus()
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ mode: "act", profileId: "p2", reasoningEffort: "high", chatOverride: true }),
			)
			await waitFor(() => expect(chip()).toHaveFocus())
		})

		it("keeps the keyed row in view as a long list moves", async () => {
			const scrollIntoView = vi.fn()
			Element.prototype.scrollIntoView = scrollIntoView
			renderChip()
			await openMenu()
			scrollIntoView.mockClear()
			fireEvent.keyDown(modelColumn(), { key: "End" })
			expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
			expect(scrollIntoView.mock.contexts.map((row) => (row as HTMLElement).textContent)).toContain("Opus 4.5")
		})

		it("Escape puts the previous choice back", async () => {
			renderChip()
			await openMenu()
			await waitFor(() => expect(modelColumn()).toHaveFocus())
			fireEvent.keyDown(modelColumn(), { key: "End" })
			fireEvent.keyDown(modelColumn(), { key: "ArrowRight" })
			fireEvent.keyDown(effortColumn(), { key: "Home" })
			fireEvent.keyDown(effortColumn(), { key: "Escape" })
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
			expect(chip()).toHaveTextContent(/^Claude workHigh$/)
			// Opening again starts from the saved choice.
			await openMenu()
			expect(selected(modelColumn())).toHaveTextContent("Claude work")
			expect(selected(effortColumn())).toHaveTextContent("High")
		})

		it("a click on a row picks it and keeps the menu open; a click outside keeps", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(within(modelColumn()).getByRole("option", { name: "Opus 4.5" }))
			expect(selected(modelColumn())).toHaveTextContent("Opus 4.5")
			// Opus 4.5 brings its own effort.
			expect(selected(effortColumn())).toHaveTextContent("Medium")
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
			fireEvent.pointerDown(document.body)
			expect(screen.queryByTestId("model-menu")).toBeNull()
			// Only the model: the extension applies its effort.
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileId: "p3" }))
			expect(mocks.assignApiProfile.mock.calls[0][0].reasoningEffort).toBeUndefined()
		})

		it("an effort picked by hand survives a model change", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(within(effortColumn()).getByRole("option", { name: "Low" }))
			fireEvent.click(within(modelColumn()).getByRole("option", { name: "Opus 4.5" }))
			expect(selected(effortColumn())).toHaveTextContent("Low")
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ profileId: "p3", reasoningEffort: "low" }),
			)
		})

		it("keeping the same choice sends nothing", async () => {
			renderChip()
			await openMenu()
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			fireEvent.keyDown(modelColumn(), { key: "ArrowUp" })
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		})

		it("a model without reasoning: no effort word, a lone disabled —", async () => {
			renderChip({ modelInfo: {}, modelId: undefined })
			expect(chip()).toHaveTextContent(/^Claude work$/)
			expect(chip()).toHaveAccessibleName("Act model: Claude work; Auto-approve: 4 of 5")
			await openMenu()
			expect(options(effortColumn()).map((option) => option.textContent)).toEqual(["—"])
			expect(effortColumn()).toHaveAttribute("aria-disabled", "true")
			// → has nowhere to go.
			fireEvent.keyDown(modelColumn(), { key: "ArrowRight" })
			expect(effortColumn()).not.toHaveFocus()
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		})

		it("with no saved models shows the model, says so and links to the Models page", async () => {
			mocks.state = { apiConfigProfiles: [], autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS }
			renderChip()
			expect(screen.getByTestId("chip-model")).toHaveTextContent("anthropic:claude-sonnet")
			await openMenu()
			expect(options(modelColumn())).toHaveLength(1)
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("No saved models yet")
			fireEvent.click(screen.getByTestId("menu-models-page"))
			expect(mocks.navigateToSettings).toHaveBeenCalledWith("api-config")
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
		it("Reset is an icon button that resets and closes", async () => {
			mocks.state.composerApiSelection = { actProfileId: "p2" }
			renderChip()
			await openMenu()
			const reset = screen.getByTestId("menu-reset")
			expect(reset).toHaveTextContent(/^$/)
			expect(reset.querySelector(".codicon-discard")).not.toBeNull()
			expect(reset).toHaveAccessibleName("Reset to default")
			expect(reset).toHaveAttribute("title", "Reset to the default model and effort")
			expect(reset).toBeEnabled()
			fireEvent.click(reset)
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resetToDefault: true }))
		})

		it("Reset is off, and says why, when nothing has changed; moving a list turns it on", async () => {
			renderChip()
			await openMenu()
			const reset = screen.getByTestId("menu-reset")
			expect(reset).toBeDisabled()
			expect(reset).toHaveAttribute("title", RESET_DISABLED_REASON)
			expect(reset).toHaveAccessibleName(`Reset to default. ${RESET_DISABLED_REASON}`)
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			expect(reset).toBeEnabled()
		})

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

		it("reads on when armed", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			mocks.state.composerNextMessageOnly = true
			renderChip()
			await openMenu()
			const toggle = screen.getByTestId("menu-next-message")
			expect(toggle).toHaveAttribute("aria-checked", "true")
			expect(toggle).toHaveAttribute("title", NEXT_MESSAGE_TIPS.on)
			expect(screen.getByTestId("next-message-track")).toHaveClass("bg-(--vscode-focusBorder)")
			expect(screen.getByTestId("next-message-thumb")).toHaveClass("translate-x-[10px]")
			fireEvent.click(toggle)
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ nextMessageOnly: false }))
		})

		it("flipping it saves at once and keeps the menu open; the lists still save on close", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			await openMenu()
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			fireEvent.click(screen.getByTestId("menu-next-message"))
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ taskId: "chat", chatOverride: true, nextMessageOnly: true }),
			)
			expect(mocks.assignApiProfile.mock.calls[0][0].profileId).toBeFalsy()
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(mocks.assignApiProfile).toHaveBeenLastCalledWith(expect.objectContaining({ profileId: "p2" }))
		})

		it("has no Next message only before there's a chat", async () => {
			renderChip()
			await openMenu()
			expect(screen.queryByTestId("menu-next-message")).toBeNull()
		})

		it("a next-message choice can't change while Cline works: the lists are inert and the menu says why", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			mocks.state.composerNextMessageOnly = true
			mocks.state.turnState = { phase: "streaming" }
			renderChip()
			expect(chip()).not.toBeDisabled()
			expect(chip()).toHaveTextContent("next message")
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent(LOCKED_REASON)
			expect(modelColumn()).toHaveAttribute("aria-disabled", "true")
			expect(modelColumn()).toHaveAttribute("title", LOCKED_REASON)
			expect(effortColumn()).toHaveAttribute("aria-disabled", "true")
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			fireEvent.click(within(effortColumn()).getByRole("option", { name: "Low" }))
			fireEvent.click(within(modelColumn()).getByRole("option", { name: "Opus 4.5" }))
			expect(selected(modelColumn())).toHaveTextContent("Claude work")
			expect(selected(effortColumn())).toHaveTextContent("High")
			const toggle = screen.getByTestId("menu-next-message")
			expect(toggle).toBeDisabled()
			expect(toggle).toHaveAttribute("title", NEXT_MESSAGE_TIPS.busy)
			// The approvals still work.
			fireEvent.click(screen.getByTestId("approval-readFiles"))
			expect(mocks.updateAutoApprovalSettings).toHaveBeenCalled()
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		})
	})
})
