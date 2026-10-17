import type { ModelInfo } from "@shared/api"
import { fireEvent, render, screen, within } from "@testing-library/react"
import type React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ModelEffortPill from "./ModelEffortPill"

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

const profiles = [
	{ id: "p1", name: "Claude work", provider: "anthropic", modelId: "claude-sonnet" },
	{ id: "p2", name: "Local vLLM", provider: "openai", modelId: "qwen" },
]

const REASONING: ModelInfo = { supportsReasoning: true } as ModelInfo

function renderPill(props: Partial<React.ComponentProps<typeof ModelEffortPill>> = {}) {
	return render(<ModelEffortPill fallbackLabel="x" mode="act" modelId="m" modelInfo={undefined} {...props} />)
}

const pill = () => screen.getByTestId("model-effort-pill")

function openMenu() {
	fireEvent.click(pill())
	return screen.getByTestId("model-effort-menu")
}

const option = (name: string) => screen.getByRole("menuitemradio", { name })
const action = (name: string) => screen.getByRole("menuitem", { name })

describe("ModelEffortPill: configuration", () => {
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
		mocks.navigateToSettings.mockReset()
		mocks.state = { apiConfigProfiles: profiles, askProfileId: "p2", actProfileId: "p1" }
	})

	it("lists saved configurations and marks the one assigned to the mode", () => {
		renderPill({ fallbackLabel: "anthropic:claude-sonnet", mode: "plan" })
		const menu = openMenu()

		expect(
			within(menu)
				.getAllByRole("menuitemradio")
				.map((item) => item.textContent),
		).toEqual(["Claude workclaude-sonnet", "Local vLLMqwen"])
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.textContent),
		).toEqual(["Reset to default", "Manage configurations…"])
		expect(option("Local vLLM qwen")).toHaveAttribute("aria-checked", "true")
		expect(pill()).toHaveTextContent("Local vLLM")
		expect(within(menu).getByText("Ask profile")).toBeInTheDocument()
	})

	it.each(["plan", "act"] as const)("shows the live %s model after a saved profile edit until rebuild", (mode) => {
		mocks.state = {
			apiConfigProfiles: [{ ...profiles[0], modelId: "edited-model" }],
			askProfileId: "p1",
			actProfileId: "p1",
			focusedSessionModels: { [mode]: { profileId: "p1", provider: "anthropic", modelId: "claude-sonnet" } },
		}
		const { rerender } = renderPill({ mode })
		expect(pill()).toHaveAttribute("title", expect.stringContaining("anthropic:claude-sonnet"))
		expect(pill().title).not.toContain("edited-model")
		expect(pill()).toHaveTextContent("Claude work (pending)")
		mocks.state.focusedSessionModels = { [mode]: { profileId: "p1", provider: "anthropic", modelId: "edited-model" } }
		rerender(<ModelEffortPill fallbackLabel="updated" mode={mode} modelId="m" modelInfo={undefined} />)
		expect(pill()).toHaveAttribute("title", expect.stringContaining("anthropic:edited-model"))
		expect(pill()).not.toHaveTextContent("pending")
	})

	it("selects the pending profile while the title describes the running model", () => {
		mocks.state.composerApiSelection = { actProfileId: "p2" }
		mocks.state.focusedSessionModels = { act: { profileId: "p1", provider: "anthropic", modelId: "claude-sonnet" } }
		renderPill()
		expect(pill()).toHaveAttribute("title", "Act currently uses anthropic:claude-sonnet; Local vLLM change pending")
		expect(pill()).toHaveTextContent("Local vLLM (pending)")
		openMenu()
		expect(option("Local vLLM qwen")).toHaveAttribute("aria-checked", "true")
		fireEvent.click(option("Claude work claude-sonnet"))
		expect(mocks.assignApiProfile).toHaveBeenCalledWith(expect.objectContaining({ mode: "act", profileId: "p1" }))
	})

	it("assigns the picked configuration to the current mode and keeps the menu open for effort", () => {
		renderPill()
		openMenu()
		fireEvent.click(option("Local vLLM qwen"))

		expect(mocks.assignApiProfile).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "act", profileId: "p2", chatOverride: true, taskId: "" }),
		)
		expect(screen.getByTestId("model-effort-menu")).toBeInTheDocument()
	})

	it("does not reassign the current configuration", () => {
		renderPill()
		openMenu()
		fireEvent.click(option("Claude work claude-sonnet"))
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
	})

	it("opens the API settings tab from Manage configurations and closes", () => {
		renderPill({ mode: "plan" })
		openMenu()
		fireEvent.click(action("Manage configurations…"))

		expect(mocks.navigateToSettings).toHaveBeenCalledWith("api-config")
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
		expect(screen.queryByTestId("model-effort-menu")).not.toBeInTheDocument()
	})

	it("arms a one-turn choice and can reset the chat to Settings defaults", () => {
		mocks.state.currentTaskItem = { id: "chat" }
		mocks.state.composerApiSelection = { actProfileId: "p2" }
		renderPill()
		expect(pill()).toHaveTextContent("chat")
		openMenu()
		fireEvent.click(action("Use next choice for next message only"))
		expect(mocks.assignApiProfile).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "chat", chatOverride: true, nextMessageOnly: true }),
		)
		fireEvent.click(action("Reset to default"))
		expect(mocks.assignApiProfile).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "chat", chatOverride: true, resetToDefault: true }),
		)
		expect(mocks.state.actProfileId).toBe("p1")
	})

	it("can't change a next-message choice while a turn runs", () => {
		mocks.state.currentTaskItem = { id: "chat" }
		mocks.state.composerNextMessageOnly = true
		mocks.state.turnState = { phase: "streaming" }
		renderPill()
		expect(pill()).toBeDisabled()
		expect(pill()).toHaveTextContent("next message")
	})

	it("labels the default on the home screen but not a next-chat override", () => {
		const { unmount } = renderPill()
		expect(pill()).toHaveTextContent("Claude workdefault")
		unmount()
		mocks.state.composerApiSelection = { actProfileId: "p2" }
		renderPill()
		expect(pill()).toHaveTextContent(/^Local vLLM$/)
		expect(pill()).not.toHaveTextContent("next chat")
	})

	it("falls back to the model label when nothing is assigned", () => {
		mocks.state = { apiConfigProfiles: [] }
		renderPill({ fallbackLabel: "anthropic:claude-sonnet", mode: "plan" })
		expect(pill()).toHaveTextContent("anthropic:claude-sonnet")
		const menu = openMenu()
		expect(within(menu).queryAllByRole("menuitemradio")).toHaveLength(0)
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.textContent),
		).toEqual(["Reset to default", "Manage configurations…"])
	})

	it("moves between items with the arrow keys and closes on Escape", () => {
		renderPill()
		const menu = openMenu()
		const first = option("Claude work claude-sonnet")
		first.focus()
		fireEvent.keyDown(first, { key: "ArrowDown" })
		expect(option("Local vLLM qwen")).toHaveFocus()
		fireEvent.keyDown(document.activeElement as Element, { key: "End" })
		expect(action("Manage configurations…")).toHaveFocus()
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" })
		expect(first).toHaveFocus()
		fireEvent.keyDown(menu, { key: "Escape" })
		expect(screen.queryByTestId("model-effort-menu")).not.toBeInTheDocument()
	})
})

describe("ModelEffortPill: effort", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.assignApiProfile.mockResolvedValue({})
		mocks.state = {
			apiConfiguration: { planModeReasoningEffort: "low", actModeReasoningEffort: "high" },
			planActSeparateModelsSetting: false,
		}
	})

	it("hides the effort choices for models without reasoning", () => {
		renderPill({ modelInfo: {} as ModelInfo, modelId: undefined })
		openMenu()
		expect(screen.queryByTestId("effort-choices")).not.toBeInTheDocument()
	})

	it("shows the effort in the pill next to the configuration", () => {
		renderPill({ modelInfo: REASONING })
		expect(screen.getByTestId("model-effort-pill-effort")).toHaveTextContent("High")
		expect(pill()).toHaveAccessibleName("Act configuration: x, High effort")
	})

	it.each(["plan", "act"] as const)("updates only %s effort without saving provider or profile settings", (mode) => {
		renderPill({ mode, modelInfo: REASONING })
		openMenu()
		fireEvent.click(option("Xhigh"))
		expect(mocks.assignApiProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ mode, reasoningEffort: "xhigh", chatOverride: true }),
		)
		expect(mocks.handleFieldChange).not.toHaveBeenCalled()
		expect(mocks.writeProviderConfig).not.toHaveBeenCalled()
		expect(mocks.saveApiProfile).not.toHaveBeenCalled()
	})

	it("shows provider default for an assigned profile with unset effective effort", () => {
		mocks.state = { apiConfiguration: {}, actProfileId: "p1" }
		renderPill({ defaultEffort: "medium", modelInfo: REASONING })
		openMenu()
		expect(option("Provider default")).toHaveAttribute("aria-checked", "true")
		expect(screen.queryByTestId("model-effort-pill-effort")).not.toBeInTheDocument()
	})

	it("reads the chat effort and shows a queued change without changing Settings", () => {
		mocks.state.composerApiSelection = { actProfileId: "p1", actModeReasoningEffort: "xhigh" }
		mocks.state.focusedSessionModels = {
			act: { profileId: "p1", provider: "anthropic", modelId: "m", reasoningEffort: "high" },
		}
		renderPill({ modelInfo: REASONING })
		expect(pill()).toHaveTextContent("(pending) · Xhigh")
		openMenu()
		expect(option("Xhigh")).toHaveAttribute("aria-checked", "true")
		expect(screen.getByText("Effort (pending)")).toBeInTheDocument()
		expect(mocks.state.apiConfiguration).toEqual({ planModeReasoningEffort: "low", actModeReasoningEffort: "high" })
	})

	it("can return to provider default", () => {
		renderPill({ modelInfo: REASONING })
		openMenu()
		fireEvent.click(option("Provider default"))
		expect(mocks.assignApiProfile).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "act", reasoningEffort: "none", chatOverride: true }),
		)
	})
})
