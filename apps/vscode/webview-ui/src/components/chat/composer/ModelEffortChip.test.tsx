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
	it("reads Model · Effort, with two click targets", () => {
		renderChip()
		const chip = screen.getByTestId("model-effort-chip")
		expect(chip).toHaveTextContent("Claude work·High")
		expect(screen.getByTestId("config-picker")).toHaveTextContent(/^Claude work$/)
		expect(screen.getByTestId("reasoning-effort-picker")).toHaveTextContent(/^High$/)
		expect(screen.queryByTestId("full-access-icon")).toBeNull()
	})

	describe("model wheel", () => {
		it("opens with the current model centered and focus in the wheel", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("config-picker"))
			const wheel = await screen.findByTestId("model-wheel")
			expect(options(wheel).map((option) => option.textContent)).toEqual([
				"Claude workclaude-sonnet",
				"Local vLLMqwen",
				"Opus 4.5claude-opus",
			])
			expect(selected(wheel)).toHaveTextContent("Claude work")
			// The current row sits at the center slot: the track is shifted so index 0 is two rows down.
			expect(screen.getByTestId("model-wheel-list").style.transform).toBe("translateY(48px)")
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
			expect(list.style.transform).toBe("translateY(0px)")
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

		it("holds the permissions above the wheel: Custom when no preset matches", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			const wheel = await screen.findByTestId("effort-wheel")
			const presets = within(wheel).getAllByRole("radio")
			expect(presets.map((preset) => preset.getAttribute("aria-label"))).toEqual([
				"Ask first",
				"Edit files",
				"Safe commands",
				"Full access",
			])
			expect(presets.every((preset) => preset.getAttribute("aria-checked") === "false")).toBe(true)
			expect(screen.getByTestId("permissions-summary")).toHaveTextContent("Custom · 4 of 5 on")
		})

		it("applies a preset onto the approval settings and keeps the popup open", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			fireEvent.click(await screen.findByTestId("permission-preset-edit"))
			expect(mocks.updateAutoApprovalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					actions: expect.objectContaining({
						readFiles: true,
						editFiles: true,
						executeSafeCommands: false,
						useBrowser: false,
						useMcp: false,
					}),
				}),
			)
			expect(screen.getByTestId("effort-wheel")).toBeInTheDocument()
		})

		it("names the matching preset", async () => {
			mocks.state.autoApprovalSettings = {
				...DEFAULT_AUTO_APPROVAL_SETTINGS,
				actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: false, executeSafeCommands: true },
			}
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			await screen.findByTestId("effort-wheel")
			expect(screen.getByTestId("permission-preset-commands")).toHaveAttribute("aria-checked", "true")
			expect(screen.getByTestId("permissions-summary")).toHaveTextContent("Safe commands")
		})

		it("Pick each action swaps the wheel for the per-action list, keeping one scroll area", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			const wheel = await screen.findByTestId("effort-wheel")
			fireEvent.click(within(wheel).getByTestId("pick-each-action"))
			expect(within(wheel).getByTestId("approvals-menu")).toBeInTheDocument()
			expect(within(wheel).queryByRole("listbox")).toBeNull()
			// Only the popup itself may scroll.
			const scrollers = [wheel, ...wheel.querySelectorAll<HTMLElement>("*")].filter((element) =>
				/\boverflow-(y-)?(auto|scroll)\b/.test(element.className),
			)
			expect(scrollers).toEqual([wheel])
			fireEvent.click(within(wheel).getByTestId("pick-each-action"))
			expect(within(wheel).getByRole("listbox")).toBeInTheDocument()
		})

		it("with Full access, the chip shows the error-colored shield before the model", async () => {
			mocks.state.autoApprovalSettings = FULL
			renderChip()
			expect(screen.getByTestId("full-access-icon")).toHaveClass("text-error")
			expect(screen.getByTestId("config-picker")).toHaveAccessibleName(/Full access on/)
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			expect(await screen.findByTestId("permission-preset-full")).toHaveClass("text-error")
		})

		it("a model without reasoning shows no effort, only the permissions", async () => {
			renderChip({ modelInfo: {}, modelId: undefined })
			expect(screen.queryByTestId("reasoning-effort-picker")).toBeNull()
			const permissions = screen.getByTestId("permissions-picker")
			expect(permissions).toHaveAccessibleName("Permissions: Custom")
			fireEvent.click(permissions)
			const popup = await screen.findByTestId("effort-wheel")
			expect(within(popup).queryByRole("listbox")).toBeNull()
			expect(within(popup).getByTestId("permission-presets")).toBeInTheDocument()
		})

		it("drops the slide under reduced motion", async () => {
			renderChip()
			fireEvent.click(screen.getByTestId("reasoning-effort-picker"))
			const list = within(await screen.findByTestId("effort-wheel")).getByRole("listbox")
			expect(list).toHaveClass("motion-reduce:transition-none", "[.vscode-reduce-motion_&]:transition-none")
		})
	})
})
