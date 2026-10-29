import { type AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ModelEffortChip from "./ModelEffortChip"

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
	{ id: "p3", name: "Opus 4.5", provider: "anthropic", modelId: "claude-opus" },
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

const options = (wheel: HTMLElement) => within(wheel).getAllByRole("option")
const selected = (wheel: HTMLElement) => within(wheel).getByRole("option", { selected: true })

beforeEach(() => {
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
	it("reads Model Effort as words (no ·), with two click targets", () => {
		renderChip()
		const chip = screen.getByTestId("model-effort-chip")
		expect(chip).toHaveTextContent(/^Claude workHigh$/)
		expect(chip.textContent).not.toContain("·")
		expect(screen.getByTestId("config-picker")).toHaveTextContent(/^Claude work$/)
		expect(screen.getByTestId("reasoning-effort-picker")).toHaveTextContent(/^High$/)
		expect(screen.queryByTestId("full-access-icon")).toBeNull()
	})

	it("hovering a part only brightens its own text: no background highlight on the chip", () => {
		renderChip()
		const chip = screen.getByTestId("model-effort-chip")
		expect(chip.className).not.toMatch(/hover:bg-|bg-toolbar-hover/)
		for (const part of [screen.getByTestId("config-picker"), screen.getByTestId("reasoning-effort-picker")]) {
			expect(part).toHaveClass("hover:text-foreground", "focus-visible:text-foreground", "bg-transparent")
			expect(part.className).not.toMatch(/hover:bg-/)
			// Keyboard users still get the focus ring.
			expect(part.className).toContain("focus-visible:outline-(--vscode-focusBorder)")
		}
	})

	describe("model wheel", () => {
		it("opens with the current model centered and focus in the wheel", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const wheel = await screen.findByTestId("model-wheel")
			// Just the names, in the chip's font; the model id is in each row's tooltip.
			expect(options(wheel).map((option) => option.textContent)).toEqual(["Claude work", "Local vLLM", "Opus 4.5"])
			expect(options(wheel)[0]).toHaveAttribute("title", "Claude work · claude-sonnet")
			expect(selected(wheel)).toHaveTextContent("Claude work")
			// The current row sits where the chip text was: the track is shifted so index 0 is `above` rows down.
			const above = Number(wheel.dataset.above)
			expect(screen.getByTestId("model-wheel-list").style.transform).toBe(`translateY(${above * 20}px)`)
			await waitFor(() => expect(screen.getByTestId("model-wheel-list")).toHaveFocus())
			expect(screen.getByTestId("config-picker")).toHaveAttribute("aria-expanded", "true")
		})

		it("↑/↓ move the pick and Enter keeps it, returning focus to the chip", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const list = await screen.findByTestId("model-wheel-list")
			fireEvent.keyDown(list, { key: "ArrowDown" })
			fireEvent.keyDown(list, { key: "ArrowDown" })
			fireEvent.keyDown(list, { key: "ArrowDown" }) // stops at the last row
			expect(selected(screen.getByTestId("model-wheel"))).toHaveTextContent("Opus 4.5")
			const above = Number(screen.getByTestId("model-wheel").dataset.above)
			expect(list.style.transform).toBe(`translateY(${(above - 2) * 20}px)`)
			fireEvent.keyDown(list, { key: "ArrowUp" })
			fireEvent.keyDown(list, { key: "Enter" })
			expect(screen.queryByTestId("model-wheel")).toBeNull()
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ mode: "act", profileId: "p2", chatOverride: true }),
			)
			expect(screen.getByTestId("config-picker")).toHaveFocus()
		})

		it("Escape puts the previous model back", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const list = await screen.findByTestId("model-wheel-list")
			fireEvent.keyDown(list, { key: "End" })
			fireEvent.keyDown(list, { key: "Escape" })
			expect(screen.queryByTestId("model-wheel")).toBeNull()
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
			expect(screen.getByTestId("config-picker")).toHaveFocus()
		})

		it("scrolls one row per wheel notch and keeps the pick on a click outside", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const viewport = await screen.findByTestId("model-wheel-viewport")
			fireEvent.wheel(viewport, { deltaY: 100 })
			expect(selected(screen.getByTestId("model-wheel"))).toHaveTextContent("Local vLLM")
			// A trackpad's small deltas add up before a row moves.
			fireEvent.wheel(viewport, { deltaY: 10 })
			expect(selected(screen.getByTestId("model-wheel"))).toHaveTextContent("Local vLLM")
			fireEvent.wheel(viewport, { deltaY: 20 })
			expect(selected(screen.getByTestId("model-wheel"))).toHaveTextContent("Opus 4.5")
			fireEvent.wheel(viewport, { deltaY: -100 })
			expect(selected(screen.getByTestId("model-wheel"))).toHaveTextContent("Local vLLM")
			act(() => {
				fireEvent.pointerDown(document.body)
			})
			expect(screen.queryByTestId("model-wheel")).toBeNull()
			expect(mocks.assignApiProfile).toHaveBeenCalledWith(expect.objectContaining({ profileId: "p2" }))
		})

		it("a click on a row picks it and closes", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const wheel = await screen.findByTestId("model-wheel")
			fireEvent.click(within(wheel).getByRole("option", { name: /Opus 4.5/ }))
			expect(screen.queryByTestId("model-wheel")).toBeNull()
			expect(mocks.assignApiProfile).toHaveBeenCalledWith(expect.objectContaining({ profileId: "p3" }))
		})

		it("picking the current model again changes nothing; clicking the chip again closes", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const wheel = await screen.findByTestId("model-wheel")
			fireEvent.click(within(wheel).getByRole("option", { name: /Claude work/ }))
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
			fireEvent.click(screen.getByTestId("config-picker"))
			expect(screen.getByTestId("model-wheel")).toBeInTheDocument()
			fireEvent.click(screen.getByTestId("config-picker"))
			expect(screen.queryByTestId("model-wheel")).toBeNull()
		})

		it("is the rolling text itself: no menu box, border, shadow or highlight band", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const wheel = await screen.findByTestId("model-wheel")
			for (const element of [wheel, ...wheel.querySelectorAll<HTMLElement>("*")]) {
				expect(element.className).not.toMatch(/(^|\s)(shadow\S*|border|border-solid|bg-menu)(\s|$)/)
			}
			expect(screen.queryByTestId("model-wheel-band")).toBeNull()
			expect(selected(wheel)).toHaveClass("text-foreground")
			expect(options(wheel)[1]).toHaveClass("text-description")
			// Neighbours fade with distance; each row covers only its own text, on the composer's color.
			const texts = within(wheel).getAllByTestId("wheel-option-text")
			expect(Number(texts[0].style.opacity)).toBe(1)
			expect(Number(texts[1].style.opacity)).toBeLessThan(1)
			expect(options(wheel)[1]).toHaveClass("w-max", "bg-input-background")
		})

		it("keeps its actions as icon buttons beside the pick, reachable by Shift+Tab", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const actions = await screen.findByTestId("model-wheel-actions")
			const buttons = within(actions).getAllByRole("button")
			expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
				"Reset to default",
				"Next message only",
				"Models page",
			])
			for (const button of buttons) {
				expect(button.title).toBe(button.getAttribute("aria-label"))
				expect(button.tabIndex).not.toBe(-1)
			}
			// Left of the pick: Shift+Tab from the wheel reaches them.
			const list = screen.getByTestId("model-wheel-list")
			expect(list.compareDocumentPosition(buttons[2]) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
			// Tabbing between the wheel and its actions keeps it open.
			fireEvent.blur(list, { relatedTarget: buttons[0] })
			expect(screen.getByTestId("model-wheel")).toBeInTheDocument()
		})

		it("links to the Models page and keeps Reset and next-message-only", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const wheel = await screen.findByTestId("model-wheel")
			fireEvent.click(within(wheel).getByRole("button", { name: "Next message only" }))
			expect(mocks.assignApiProfile).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: "chat", chatOverride: true, nextMessageOnly: true }),
			)
			fireEvent.click(screen.getByTestId("config-picker"))
			fireEvent.click(within(await screen.findByTestId("model-wheel")).getByRole("button", { name: "Reset to default" }))
			expect(mocks.assignApiProfile).toHaveBeenCalledWith(expect.objectContaining({ resetToDefault: true }))
			fireEvent.click(screen.getByTestId("config-picker"))
			fireEvent.click(within(await screen.findByTestId("model-wheel")).getByRole("button", { name: "Models page" }))
			expect(mocks.navigateToSettings).toHaveBeenCalledWith("api-config")
		})

		it("shows the running model's pending change on the chip", () => {
			mocks.state.composerApiSelection = { actProfileId: "p2" }
			mocks.state.focusedSessionModels = { act: { profileId: "p1", provider: "anthropic", modelId: "claude-sonnet" } }
			renderChip()
			expect(screen.getByTestId("config-picker")).toHaveTextContent("Local vLLM(pending)")
			expect(screen.getByTestId("config-picker").title).toContain("Act currently uses anthropic:claude-sonnet")
		})

		it("can't open a next-message choice while a turn runs, and says why", () => {
			mocks.state.currentTaskItem = { id: "chat" }
			mocks.state.composerNextMessageOnly = true
			mocks.state.turnState = { phase: "streaming" }
			renderChip()
			const button = screen.getByTestId("config-picker")
			expect(button).toBeDisabled()
			expect(button).toHaveTextContent("next message")
			expect(button.title).toMatch(/can't change while Cline is working/)
		})

		it("with no saved models shows the model and a way to the Models page", async () => {
			mocks.state = { apiConfigProfiles: [], autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS }
			renderChip()
			expect(screen.getByTestId("config-picker")).toHaveTextContent("anthropic:claude-sonnet")
			fireEvent.click(screen.getByTestId("config-picker"))
			const wheel = await screen.findByTestId("model-wheel")
			expect(options(wheel)).toHaveLength(1)
			expect(wheel).toHaveTextContent("No saved models yet")
			expect(within(wheel).getByRole("button", { name: "Models page" })).toBeInTheDocument()
		})
	})

	describe("effort wheel", () => {
		it("lists the efforts with the current one centered and picks another", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			const wheel = await screen.findByTestId("effort-wheel")
			expect(options(wheel).map((option) => option.textContent)).toEqual([
				"Provider default",
				"Low",
				"Medium",
				"High",
				"XHigh",
			])
			expect(selected(wheel)).toHaveTextContent("High")
			fireEvent.keyDown(within(wheel).getByRole("listbox"), { key: "ArrowDown" })
			fireEvent.keyDown(within(wheel).getByRole("listbox"), { key: "Enter" })
			expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ mode: "act", reasoningEffort: "xhigh", chatOverride: true }),
			)
			expect(screen.getByTestId("reasoning-effort-picker")).toHaveFocus()
		})

		it("shows the five auto-approve actions as toggles just above the wheel", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			const wheel = await screen.findByTestId("effort-wheel")
			const toggles = within(within(wheel).getByTestId("approval-toggles")).getAllByRole("button")
			expect(toggles.map((toggle) => toggle.textContent)).toEqual(["Read", "Edit", "Commands", "Web Fetch", "MCP"])
			// Defaults: everything but commands is on.
			expect(toggles.map((toggle) => toggle.getAttribute("aria-pressed"))).toEqual([
				"true",
				"true",
				"false",
				"true",
				"true",
			])
			expect(
				within(wheel).getByTestId("approval-toggles").compareDocumentPosition(within(wheel).getByRole("listbox")) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy()
			// No presets, summary or per-action expansion any more.
			expect(within(wheel).queryByRole("radio")).toBeNull()
			expect(within(wheel).queryByTestId("permissions-summary")).toBeNull()
			expect(within(wheel).queryByTestId("pick-each-action")).toBeNull()
		})

		it("each toggle changes its own setting at once and keeps the wheel open", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			fireEvent.click(await screen.findByTestId("approval-executeSafeCommands"))
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
			expect(screen.getByTestId("effort-wheel")).toBeInTheDocument()
		})

		it("with every action on, the chip and the row show the error-colored shield", async () => {
			mocks.state.autoApprovalSettings = FULL
			renderChip()
			expect(screen.getByTestId("full-access-icon")).toHaveClass("text-error")
			expect(screen.getByTestId("config-picker")).toHaveAccessibleName(/every action auto-approved/)
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			expect(await screen.findByTestId("approvals-all-on")).toHaveClass("text-error")
			expect(screen.getByTestId("approval-useMcp")).toHaveClass("text-error")
		})

		it("a model without reasoning shows no effort, only the approvals", async () => {
			renderChip({ modelInfo: {}, modelId: undefined })
			expect(screen.queryByTestId("reasoning-effort-picker")).toBeNull()
			const permissions = screen.getByTestId("permissions-picker")
			expect(permissions).toHaveAccessibleName("Auto-approve: 4 of 5")
			fireEvent.click(permissions)
			const popup = await screen.findByTestId("effort-wheel")
			expect(within(popup).queryByRole("listbox")).toBeNull()
			expect(within(popup).getByTestId("approval-toggles")).toBeInTheDocument()
		})

		it("drops the slide under reduced motion", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			const list = within(await screen.findByTestId("effort-wheel")).getByRole("listbox")
			expect(list).toHaveClass("motion-reduce:transition-none", "[.vscode-reduce-motion_&]:transition-none")
		})
	})
})
