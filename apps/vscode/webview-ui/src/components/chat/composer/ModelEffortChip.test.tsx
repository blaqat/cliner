import { type AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ModelEffortChip, { LOCKED_REASON } from "./ModelEffortChip"

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
const modelColumn = () => screen.getByTestId("model-wheel")
const effortColumn = () => screen.getByTestId("effort-wheel")

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
		it("opens from a click on the chip: tiles, then the double wheel, then the footer, on a menu surface", async () => {
			renderChip()
			const menu = await openMenu()
			expect(chip()).toHaveAttribute("aria-expanded", "true")
			expect(menu).toHaveClass("bg-menu", "border", "shadow-md")
			const order = [
				within(menu).getByTestId("approval-tiles"),
				within(menu).getByTestId("double-wheel"),
				within(menu).getByTestId("menu-reset"),
				within(menu).getByTestId("menu-models-page"),
			]
			for (let i = 1; i < order.length; i++) {
				expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
			}
			// Focus lands on the model wheel.
			await waitFor(() => expect(modelColumn()).toHaveFocus())
			// A click on the chip again closes it.
			fireEvent.click(chip())
			expect(screen.queryByTestId("model-menu")).toBeNull()
		})

		it("centres the current model and effort on the selection band, with a + between them", async () => {
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
			// The middle of five 24px rows: index 0 sits two rows down, index 3 one row up.
			expect(screen.getByTestId("model-wheel-track").style.transform).toBe("translateY(48px)")
			expect(screen.getByTestId("effort-wheel-track").style.transform).toBe("translateY(-24px)")
			expect(screen.getByTestId("wheel-band")).toHaveClass("bg-selection")
			expect(screen.getByTestId("wheel-band").style.top).toBe("48px")
			expect(screen.getByTestId("wheel-joiner")).toHaveTextContent(/^\+$/)
		})

		it("right-aligns the model wheel and left-aligns the effort wheel, so they meet at the +", async () => {
			renderChip()
			await openMenu()
			expect(modelColumn()).toHaveAttribute("data-align", "end")
			expect(effortColumn()).toHaveAttribute("data-align", "start")
			for (const option of options(modelColumn())) expect(option).toHaveClass("text-right")
			for (const option of options(effortColumn())) expect(option).toHaveClass("text-left")
			const joiner = screen.getByTestId("wheel-joiner")
			expect(modelColumn().compareDocumentPosition(joiner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
			expect(joiner.compareDocumentPosition(effortColumn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

		it("scrolls each column on its own: one row per notch, trackpad deltas add up; a click outside keeps", async () => {
			renderChip()
			await openMenu()
			fireEvent.wheel(effortColumn(), { deltaY: -100 })
			expect(selected(effortColumn())).toHaveTextContent("Medium")
			expect(selected(modelColumn())).toHaveTextContent("Claude work")
			fireEvent.wheel(modelColumn(), { deltaY: 100 })
			expect(selected(modelColumn())).toHaveTextContent("Local vLLM")
			fireEvent.wheel(modelColumn(), { deltaY: 10 })
			expect(selected(modelColumn())).toHaveTextContent("Local vLLM")
			fireEvent.wheel(modelColumn(), { deltaY: 20 })
			expect(selected(modelColumn())).toHaveTextContent("Opus 4.5")
			// The effort was rolled by hand, so the new model doesn't replace it with its own.
			expect(selected(effortColumn())).toHaveTextContent("Medium")
			fireEvent.wheel(modelColumn(), { deltaY: -100 })
			expect(selected(modelColumn())).toHaveTextContent("Local vLLM")
			fireEvent.pointerDown(document.body)
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ profileId: "p2", reasoningEffort: "medium" }),
			)
		})

		it("a click on a row brings it to the middle and keeps the menu open", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(within(modelColumn()).getByRole("option", { name: "Opus 4.5" }))
			expect(selected(modelColumn())).toHaveTextContent("Opus 4.5")
			expect(screen.getByTestId("model-wheel-track").style.transform).toBe("translateY(0px)")
			// Opus 4.5 brings its own effort.
			expect(selected(effortColumn())).toHaveTextContent("Medium")
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			// Only the model: the extension applies its effort.
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileId: "p3" }))
			expect(mocks.assignApiProfile.mock.calls[0][0].reasoningEffort).toBeUndefined()
		})

		it("keeping the same choice sends nothing", async () => {
			renderChip()
			await openMenu()
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			fireEvent.keyDown(modelColumn(), { key: "ArrowUp" })
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		})

		it("drops the slide under reduced motion", async () => {
			renderChip()
			await openMenu()
			for (const id of ["model-wheel-track", "effort-wheel-track"]) {
				expect(screen.getByTestId(id)).toHaveClass(
					"motion-reduce:transition-none",
					"[.vscode-reduce-motion_&]:transition-none",
				)
			}
		})

		it("a model without reasoning: no effort word, a lone disabled — and no +", async () => {
			renderChip({ modelInfo: {}, modelId: undefined })
			expect(chip()).toHaveTextContent(/^Claude work$/)
			expect(chip()).toHaveAccessibleName("Act model: Claude work; Auto-approve: 4 of 5")
			await openMenu()
			expect(options(effortColumn()).map((option) => option.textContent)).toEqual(["—"])
			expect(effortColumn()).toHaveAttribute("aria-disabled", "true")
			expect(screen.getByTestId("wheel-joiner")).toHaveTextContent(/^$/)
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
		it("are five icon-only tiles with names, pressed state and a count", async () => {
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
			expect(screen.getByTestId("approvals-count")).toHaveTextContent("4 of 5")
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

		it("with all five on, the tiles stay blue and the count becomes an error-colored All on", async () => {
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
		it("Reset to default resets and closes", async () => {
			renderChip()
			await openMenu()
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			fireEvent.click(screen.getByTestId("menu-reset"))
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resetToDefault: true }))
		})

		it("Next message only arms what the wheels show for one message", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			await openMenu()
			fireEvent.keyDown(modelColumn(), { key: "ArrowDown" })
			fireEvent.click(screen.getByTestId("menu-next-message"))
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ taskId: "chat", chatOverride: true, nextMessageOnly: true, profileId: "p2" }),
			)
		})

		it("has no Next message only before there's a chat", async () => {
			renderChip()
			await openMenu()
			expect(screen.queryByTestId("menu-next-message")).toBeNull()
		})

		it("a next-message choice can't change while Cline works: the wheels are inert and the menu says why", async () => {
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
			fireEvent.wheel(effortColumn(), { deltaY: 100 })
			fireEvent.click(within(modelColumn()).getByRole("option", { name: "Opus 4.5" }))
			expect(selected(modelColumn())).toHaveTextContent("Claude work")
			expect(selected(effortColumn())).toHaveTextContent("High")
			expect(screen.getByTestId("menu-next-message")).toBeDisabled()
			// The approvals still work.
			fireEvent.click(screen.getByTestId("approval-readFiles"))
			expect(mocks.updateAutoApprovalSettings).toHaveBeenCalled()
			fireEvent.keyDown(modelColumn(), { key: "Enter" })
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		})
	})
})
