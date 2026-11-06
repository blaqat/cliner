import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
import ModelEffortChip, { LOCKED_REASON, NEXT_MESSAGE_TIPS } from "./ModelEffortChip"

const mocks = vi.hoisted(() => ({
	assignApiProfile: vi.fn(),
	setThreadModelSelection: vi.fn(),
	getModelSettings: vi.fn(),
	makeModelDefault: vi.fn(),
	navigateToSettings: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ ...mocks.state, navigateToSettings: mocks.navigateToSettings }),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		assignApiProfile: (request: unknown) => mocks.assignApiProfile(request),
		setThreadModelSelection: (request: unknown) => mocks.setThreadModelSelection(request),
		getModelSettings: (request: unknown) => mocks.getModelSettings(request),
		makeModelDefault: (request: unknown) => mocks.makeModelDefault(request),
	},
	StateServiceClient: { updateAutoApprovalSettings: vi.fn() },
}))

const renderChip = (props: Partial<React.ComponentProps<typeof ModelEffortChip>> = {}) =>
	render(<ModelEffortChip fallbackLabel="legacy label" mode="act" {...props} />)

const chip = () => screen.getByTestId("model-effort-chip")
const models = () => screen.getByTestId("model-list")
const levels = () => screen.getByTestId("effort-list")
const option = (column: HTMLElement, name: string) => within(column).getByRole("option", { name })
const sent = (mock: typeof mocks.setThreadModelSelection) => mock.mock.calls.map(([request]) => JSON.parse(request.json))

async function openMenu() {
	fireEvent.click(chip())
	const menu = await screen.findByTestId("model-menu")
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
	return menu
}

const flush = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))

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
	mocks.setThreadModelSelection.mockReset().mockResolvedValue({ json: '{"applied":true}' })
	mocks.getModelSettings.mockReset().mockResolvedValue({ json: JSON.stringify({ settings: { revision: 12 } }) })
	mocks.makeModelDefault.mockReset().mockResolvedValue({ json: "{}" })
	mocks.navigateToSettings.mockReset()
	mocks.state = {
		modelSettings: modelSettingsFixture(),
		// Today's data, still published beside the new store: none of it may show.
		apiConfigProfiles: [{ id: "p1", name: "Old profile", provider: "anthropic", modelId: "claude" }],
		actProfileId: "p1",
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
	}
})

describe("ModelEffortChip with the new model settings", () => {
	describe("what it shows", () => {
		it("reads the role's pick from the store, not the saved profiles", () => {
			renderChip()
			expect(chip()).toHaveTextContent(/^GPT-6 Sol · Company gatewayMed$/)
			expect(chip()).toHaveAccessibleName(/Act model: GPT-6 Sol · Company gateway, effort Medium/)
		})

		it("isn't pending while the live build is what's picked", () => {
			const { roles, models: rows } = (mocks.state.modelSettings as ReturnType<typeof modelSettingsFixture>).settings
			const model = rows.find((row) => row.id === roles.chat?.modelId)!
			mocks.state.focusedSessionModels = {
				act: { provider: "openai", modelId: model.upstreamId, reasoningEffort: roles.chat?.levelId, pick: roles.chat },
			}
			renderChip()
			expect(chip()).not.toHaveTextContent("(pending)")
			expect(chip()).toHaveTextContent(/^GPT-6 Sol · Company gatewayMed$/)
		})

		it("is pending while the live build is on another row or level", () => {
			const { roles, models: rows } = (mocks.state.modelSettings as ReturnType<typeof modelSettingsFixture>).settings
			const model = rows.find((row) => row.id === roles.chat?.modelId)!
			mocks.state.focusedSessionModels = {
				act: {
					provider: "openai",
					modelId: model.upstreamId,
					pick: { modelId: "another-row", levelId: roles.chat?.levelId },
				},
			}
			const first = renderChip()
			expect(chip()).toHaveTextContent("GPT-6 Sol · Company gateway(pending)")
			first.unmount()
			mocks.state.focusedSessionModels = {
				act: { provider: "openai", modelId: model.upstreamId, pick: { modelId: model.id, levelId: "default" } },
			}
			renderChip()
			expect(chip()).toHaveTextContent(/Med \(pending\)$/)
		})

		it("names the model and its connection in the tooltip, not provider:model", () => {
			const { roles, models: rows } = (mocks.state.modelSettings as ReturnType<typeof modelSettingsFixture>).settings
			const model = rows.find((row) => row.id === roles.chat?.modelId)!
			mocks.state.focusedSessionModels = {
				act: { provider: "openai", modelId: model.upstreamId, pick: roles.chat },
			}
			const first = renderChip()
			expect(chip().title).toContain("Act currently uses GPT-6 Sol · Company gateway on Company gateway")
			expect(chip().title).not.toContain("openai:")
			first.unmount()
			// A build that didn't come from a pick is found by its upstream id.
			mocks.state.focusedSessionModels = { act: { provider: "openai", modelId: model.upstreamId } }
			const second = renderChip()
			expect(chip().title).not.toContain("openai:")
			expect(chip().title).toContain("on Company gateway")
			second.unmount()
			mocks.state.focusedSessionModels = undefined
			renderChip()
			expect(chip().title).toContain("Act uses GPT-6 Sol · Company gateway on Company gateway")
		})

		it("lists every configured chat and unknown model, with no starred filter", async () => {
			renderChip()
			await openMenu()
			expect(
				within(models())
					.getAllByRole("option")
					.map((row) => row.textContent),
			).toEqual(["GPT-6 Sol", "GPT-5.4", "acme-tuned-coder", "Qwen 3", "Mistral 8", "GPT-6 Sol"])
			expect(screen.getAllByTestId("list-group").map((group) => group.textContent)).toEqual([
				"Company gateway",
				"Local vLLM",
			])
		})

		it("reads the thread's own pick, per mode", () => {
			mocks.state.composerApiSelection = {
				modelSelectionV1: {
					version: 1,
					act: { modelId: "g54", levelId: "high" },
					ask: { modelId: "qwen", levelId: "default" },
				},
			}
			const { unmount } = renderChip()
			expect(chip()).toHaveTextContent(/^GPT-5.4High$/)
			unmount()
			renderChip({ mode: "plan" })
			expect(chip()).toHaveTextContent(/^Qwen 3$/)
		})

		it("keeps the composer's shape: tiles, lists, footer, then the default line", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			const menu = await openMenu()
			const order = [
				"approval-tiles",
				"model-effort-lists",
				"menu-reset",
				"menu-next-message",
				"menu-models-page",
				"menu-make-default",
			].map((id) => within(menu).getByTestId(id))
			for (let i = 1; i < order.length; i++) {
				expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
			}
		})

		it("greys levels the model doesn't offer, with the reason", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			expect(option(levels(), "Low")).toHaveAttribute("title", "GPT-5.4 doesn't offer Low")
			expect(option(levels(), "Low")).toHaveAttribute("aria-disabled", "true")
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Moved to Default: GPT-5.4 doesn't offer Medium.")
		})
	})

	describe("saving a pick", () => {
		it("a click calls setThreadModelSelection at once, per the contract, and never the old RPC", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			await openMenu()
			fireEvent.click(option(models(), "Qwen 3"))
			const expected = [
				{ taskId: "chat", mode: "act", pick: { modelId: "qwen", levelId: "default" }, nextMessageOnly: false },
			]
			expect(sent(mocks.setThreadModelSelection)).toEqual(expected)
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(sent(mocks.setThreadModelSelection)).toEqual(expected)
			expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		})

		it("Enter saves what the keys moved", async () => {
			mocks.state.currentTaskItem = { id: "chat" }
			renderChip()
			await openMenu()
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			expect(mocks.setThreadModelSelection).not.toHaveBeenCalled()
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(sent(mocks.setThreadModelSelection)).toHaveLength(1)
		})

		it("the home screen sends the empty task id", async () => {
			renderChip({ mode: "plan" })
			await openMenu()
			fireEvent.click(option(levels(), "High"))
			fireEvent.pointerDown(document.body)
			expect(sent(mocks.setThreadModelSelection)).toEqual([
				{ taskId: "", mode: "plan", pick: { modelId: "sol", levelId: "high" }, nextMessageOnly: false },
			])
		})

		it("Escape saves nothing the keys moved", async () => {
			renderChip()
			await openMenu()
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			fireEvent.keyDown(models(), { key: "Escape" })
			expect(mocks.setThreadModelSelection).not.toHaveBeenCalled()
		})

		it("says so in the menu when the host refuses", async () => {
			mocks.setThreadModelSelection.mockRejectedValue(new Error("Focused chat changed during selection"))
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			renderChip()
			await openMenu()
			fireEvent.click(option(levels(), "High"))
			await flush()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Focused chat changed during selection")
			fireEvent.keyDown(models(), { key: "Enter" })
			await flush()
			expect(mocks.setThreadModelSelection).toHaveBeenCalledOnce()
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Focused chat changed during selection")
			consoleError.mockRestore()
		})
	})

	describe("next message only", () => {
		beforeEach(() => {
			mocks.state.currentTaskItem = { id: "chat" }
		})

		it("flipping on shows at once, keeps the menu open, and goes out with the next pick, once", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-next-message"))
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
			expect(screen.getByTestId("menu-next-message")).toHaveAttribute("aria-checked", "true")
			expect(chip()).toHaveTextContent("next message")
			expect(mocks.setThreadModelSelection).not.toHaveBeenCalled()
			fireEvent.click(option(models(), "Qwen 3"))
			const expected = [
				{ taskId: "chat", mode: "act", pick: { modelId: "qwen", levelId: "default" }, nextMessageOnly: true },
			]
			expect(sent(mocks.setThreadModelSelection)).toEqual(expected)
			// The host hasn't answered yet: closing must not arm the old model on top of it.
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(sent(mocks.setThreadModelSelection)).toEqual(expected)
		})

		it("a flip after a click goes out with the clicked pick on close, even before the host has answered", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(option(models(), "Qwen 3"))
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(sent(mocks.setThreadModelSelection)).toEqual([
				{ taskId: "chat", mode: "act", pick: { modelId: "qwen", levelId: "default" }, nextMessageOnly: false },
				{ taskId: "chat", mode: "act", pick: { modelId: "qwen", levelId: "default" }, nextMessageOnly: true },
			])
		})

		it("flipping back after a pick went out armed disarms it on close", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.click(option(models(), "Qwen 3"))
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(sent(mocks.setThreadModelSelection).map((request) => request.nextMessageOnly)).toEqual([true, false])
		})

		it("a refused pick isn't sent again on close", async () => {
			mocks.setThreadModelSelection.mockRejectedValue(new Error("Wait for this turn to finish"))
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.click(option(models(), "Qwen 3"))
			await flush()
			fireEvent.keyDown(models(), { key: "Enter" })
			await flush()
			expect(mocks.setThreadModelSelection).toHaveBeenCalledOnce()
			expect(chip()).not.toHaveTextContent("next message")
			consoleError.mockRestore()
		})

		it("keeps a flip with the same pick when the menu closes", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(sent(mocks.setThreadModelSelection)).toEqual([
				{ taskId: "chat", mode: "act", pick: { modelId: "sol", levelId: "medium" }, nextMessageOnly: true },
			])
		})

		it("Escape drops the flip along with what the keys moved, and arms nothing on the old model", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			fireEvent.keyDown(screen.getByTestId("model-menu"), { key: "Escape" })
			await flush()
			expect(mocks.setThreadModelSelection).not.toHaveBeenCalled()
			expect(chip()).not.toHaveTextContent("next message")
		})

		it("Escape after a click drops only a later flip: the chip shows what was sent", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(option(models(), "Qwen 3"))
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.keyDown(screen.getByTestId("model-menu"), { key: "Escape" })
			await flush()
			expect(sent(mocks.setThreadModelSelection).map((request) => request.nextMessageOnly)).toEqual([false])
			expect(chip()).not.toHaveTextContent("next message")
		})

		it("Escape after an armed click keeps it armed while the host answers", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.click(option(models(), "Qwen 3"))
			fireEvent.keyDown(screen.getByTestId("model-menu"), { key: "Escape" })
			await flush()
			expect(sent(mocks.setThreadModelSelection).map((request) => request.nextMessageOnly)).toEqual([true])
			expect(chip()).toHaveTextContent("next message")
		})

		it("Escape leaves an armed pick armed after flipping it off", async () => {
			mocks.state.composerNextMessageOnly = true
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-next-message"))
			expect(chip()).not.toHaveTextContent("next message")
			fireEvent.keyDown(screen.getByTestId("model-menu"), { key: "Escape" })
			await flush()
			expect(mocks.setThreadModelSelection).not.toHaveBeenCalled()
			expect(chip()).toHaveTextContent("next message")
		})

		it("shortens the marker when the row hides the effort word, and still names it for screen readers", () => {
			mocks.state.composerNextMessageOnly = true
			renderChip({ compactEffort: true })
			expect(screen.getByTestId("chip-next-message")).toHaveTextContent(/^next$/)
			expect(chip()).toHaveAccessibleName(/next message only/)
		})

		it("lets the marker take the model name's room only on the tightest row", () => {
			mocks.state.composerNextMessageOnly = true
			const first = renderChip({ compactEffort: true })
			expect(screen.getByTestId("chip-model")).toHaveClass("min-w-[3ch]")
			first.unmount()
			renderChip({ compactEffort: true, tightChip: true })
			expect(screen.getByTestId("chip-model")).toHaveClass("min-w-0")
		})

		it("reads on when armed; flipping off keeps the pick for this chat", async () => {
			mocks.state.composerNextMessageOnly = true
			mocks.state.composerApiSelection = {
				modelSelectionV1: { version: 1, act: { modelId: "g54", levelId: "high" }, ask: null },
			}
			renderChip()
			await openMenu()
			expect(screen.getByTestId("menu-next-message")).toHaveAttribute("title", NEXT_MESSAGE_TIPS.on)
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(sent(mocks.setThreadModelSelection)).toEqual([
				{ taskId: "chat", mode: "act", pick: { modelId: "g54", levelId: "high" }, nextMessageOnly: false },
			])
		})

		it("turns back off and says why if the host can't do it yet", async () => {
			mocks.setThreadModelSelection.mockRejectedValue(new Error("Next-message configured selections are not implemented"))
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-next-message"))
			fireEvent.keyDown(models(), { key: "Enter" })
			await flush()
			await openMenu()
			expect(screen.getByTestId("menu-next-message")).toHaveAttribute("aria-checked", "false")
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("not implemented")
			consoleError.mockRestore()
		})

		it("locks the lists while Cline works, like today", async () => {
			mocks.state.composerNextMessageOnly = true
			mocks.state.turnState = { phase: "streaming" }
			renderChip()
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent(LOCKED_REASON)
			expect(models()).toHaveAttribute("aria-disabled", "true")
			expect(screen.getByTestId("menu-next-message")).toBeDisabled()
			expect(screen.getByTestId("menu-next-message")).toHaveAttribute("title", NEXT_MESSAGE_TIPS.busy)
			fireEvent.click(option(models(), "Qwen 3"))
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(mocks.setThreadModelSelection).not.toHaveBeenCalled()
		})
	})

	describe("Reset", () => {
		it("goes back to the role's default, through the new RPC", async () => {
			mocks.state.composerApiSelection = {
				modelSelectionV1: { version: 1, act: { modelId: "qwen", levelId: "default" }, ask: null },
			}
			renderChip()
			await openMenu()
			fireEvent.click(screen.getByTestId("menu-reset"))
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(sent(mocks.setThreadModelSelection)).toEqual([
				{ taskId: "", mode: "act", pick: { modelId: "sol", levelId: "medium" }, nextMessageOnly: false },
			])
		})

		it("is off, saying why, when it's already the default or there's no default", async () => {
			const { unmount } = renderChip()
			await openMenu()
			expect(screen.getByTestId("menu-reset")).toBeDisabled()
			expect(screen.getByTestId("menu-reset")).toHaveAttribute("title", expect.stringContaining("already uses the default"))
			fireEvent.keyDown(models(), { key: "Escape" })
			unmount()
			const state = modelSettingsFixture()
			state.settings.roles.chat = null
			mocks.state.modelSettings = state
			renderChip()
			await openMenu()
			expect(screen.getByTestId("menu-reset")).toHaveAttribute(
				"title",
				"Nothing to reset to: no default Chat model is set yet",
			)
		})
	})

	describe("Make this the default", () => {
		const makeDefault = () => screen.getByTestId("menu-make-default")

		it("reads the fresh revision, then sets what the lists show, with the mode", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(option(models(), "Qwen 3"))
			expect(makeDefault()).toHaveTextContent("Make this the default")
			fireEvent.click(makeDefault())
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
			await flush()
			expect(sent(mocks.makeModelDefault)).toEqual([
				{ expectedRevision: 12, mode: "act", pick: { modelId: "qwen", levelId: "default" } },
			])
		})

		it("on Ask with its own model, sends plan and says it sets Ask", async () => {
			const state = modelSettingsFixture()
			state.settings.roles.ask = { enabled: true, pick: { modelId: "qwen", levelId: "default" } }
			mocks.state.modelSettings = state
			renderChip({ mode: "plan" })
			expect(chip()).toHaveTextContent(/^Qwen 3$/)
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			expect(makeDefault()).toHaveAttribute("title", expect.stringContaining("Sets the Ask model"))
			fireEvent.click(makeDefault())
			await flush()
			expect(sent(mocks.makeModelDefault)[0]).toMatchObject({ mode: "plan", pick: { modelId: "g54", levelId: "default" } })
		})

		it("on Ask without its own model, says it sets Chat, and compares against Chat", async () => {
			renderChip({ mode: "plan" })
			await openMenu()
			expect(makeDefault()).toBeDisabled()
			expect(makeDefault()).toHaveTextContent("This is the default")
			fireEvent.click(option(models(), "GPT-5.4"))
			expect(makeDefault()).toHaveTextContent("Make this the default")
			expect(makeDefault()).toHaveAttribute("title", expect.stringContaining("sets the Chat model"))
			fireEvent.click(makeDefault())
			await flush()
			expect(sent(mocks.makeModelDefault)[0].mode).toBe("plan")
		})

		it("in Act says Chat", async () => {
			renderChip()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			expect(makeDefault()).toHaveAttribute(
				"title",
				"Sets the Chat model: new chats start with this. Other chats keep theirs.",
			)
		})

		it("is off, saying why, on a pick that can't run", async () => {
			mocks.state.composerApiSelection = {
				modelSelectionV1: { version: 1, act: { modelId: "g54", levelId: "medium" }, ask: null },
			}
			const { unmount } = renderChip()
			await openMenu()
			expect(makeDefault()).toBeDisabled()
			expect(makeDefault()).toHaveAttribute("title", "GPT-5.4 doesn't offer this level: pick another first")
			fireEvent.keyDown(models(), { key: "Escape" })
			unmount()
			mocks.state.composerApiSelection = {
				modelSelectionV1: { version: 1, act: { modelId: "broken", levelId: "default" }, ask: null },
			}
			renderChip()
			await openMenu()
			expect(makeDefault()).toHaveAttribute("title", "Connection credentials are missing.")
		})

		it("says so in the menu if the host refuses", async () => {
			mocks.makeModelDefault.mockRejectedValue(new Error("Settings changed; try again"))
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			renderChip()
			await openMenu()
			fireEvent.click(option(models(), "Qwen 3"))
			fireEvent.click(makeDefault())
			await flush()
			await waitFor(() =>
				expect(screen.getByTestId("model-menu-note")).toHaveTextContent(
					"Couldn't make this the default: Settings changed; try again",
				),
			)
			consoleError.mockRestore()
		})
	})

	describe("nothing set up", () => {
		it("no models: the chip says so, and the menu links to Settings › Models", async () => {
			const state = modelSettingsFixture()
			state.settings.models = []
			state.settings.roles.chat = null
			mocks.state.modelSettings = state
			renderChip()
			expect(chip()).toHaveTextContent("No models yet")
			const menu = await openMenu()
			expect(within(menu).getByTestId("approval-tiles")).toBeInTheDocument()
			expect(screen.getByTestId("model-menu-empty")).toHaveTextContent("No models set up yet.")
			expect(screen.getByTestId("menu-make-default")).toBeDisabled()
			expect(screen.getByTestId("menu-make-default")).toHaveAttribute("title", "Pick a model first")
			fireEvent.click(screen.getByTestId("model-menu-fix"))
			expect(mocks.navigateToSettings).toHaveBeenCalledWith("models")
		})

		it("no role picked: says nothing can run, and links to the pick", async () => {
			const state = modelSettingsFixture()
			state.settings.roles.chat = null
			mocks.state.modelSettings = state
			renderChip()
			expect(chip()).toHaveTextContent("Pick a model")
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("No Chat model is picked, so nothing can run.")
			fireEvent.click(screen.getByTestId("model-menu-fix"))
			expect(mocks.navigateToSettings).toHaveBeenCalledWith("models")
		})

		it("a thread whose model is gone runs on the default", async () => {
			const state = modelSettingsFixture()
			mocks.state.modelSettings = state
			mocks.state.composerApiSelection = {
				modelSelectionV1: { version: 1, act: { modelId: "gone", levelId: "low" }, ask: null },
			}
			const fallback = state.settings.models.find((model) => model.id === state.settings.roles.chat?.modelId)
			renderChip()
			expect(chip()).toHaveTextContent(fallback?.name as string)
			await openMenu()
			expect(screen.queryByTestId("model-menu-note")).toBeNull()
			expect(within(models()).getByRole("option", { selected: true })).toHaveTextContent(fallback?.name as string)
		})

		it("a thread whose model is gone asks for one when there's no default", async () => {
			const state = modelSettingsFixture()
			state.settings.roles.chat = null
			mocks.state.modelSettings = state
			mocks.state.composerApiSelection = {
				modelSelectionV1: { version: 1, act: { modelId: "gone", levelId: "low" }, ask: null },
			}
			renderChip()
			expect(chip()).toHaveTextContent("Pick a model")
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Pick one here, or set the default in")
			expect(within(models()).queryByRole("option", { selected: true })).toBeNull()
		})
	})
})
