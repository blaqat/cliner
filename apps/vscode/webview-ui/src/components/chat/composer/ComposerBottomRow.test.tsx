import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { PlanActMode } from "@shared/proto/cline/state"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
import { USE_SCRIPT_EVENT } from "../../topbar/topBarPanels"
import ChatTextArea, { type ChatTextAreaProps } from "../ChatTextArea"
import { type ComposerRowLayout, composerRowLayout, FULL_COMPOSER_ROW } from "./composerRowLayout"

const mocks = vi.hoisted(() => ({
	inThread: false,
	modKey: "⌘",
	togglePlanActModeProto: vi.fn(async () => ({})),
	// Stable references: a new object every render would re-run effects that depend on it.
	thread: { id: "thread", taskGroupId: "sso" },
	taskGroups: [{ id: "sso", title: "SSO redirect loop", tags: [], createdAt: 0, updatedAt: 0, noteCount: 0 }],
	modelSettings: undefined as unknown,
	selected: { selectedProvider: "anthropic", selectedModelId: "model" },
}))
mocks.modelSettings = modelSettingsFixture()

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mode: "act",
		apiConfiguration: { actModeReasoningEffort: "high" },
		modelSettings: mocks.modelSettings,
		platform: "darwin",
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		remoteWorkflowToggles: {},
		mcpServers: [],
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
		taskGroups: mocks.taskGroups,
		currentTaskItem: mocks.inThread ? mocks.thread : undefined,
	}),
}))

vi.mock("@/context/PlatformContext", () => ({
	usePlatform: () => ({ togglePlanActKeys: "Meta+Shift+a" }),
}))

vi.mock("@/utils/platformUtils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils/platformUtils")>()),
	modKeyLabel: () => mocks.modKey,
}))

vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		...mocks.selected,
		// Reasoning, so the chip has its effort text.
		selectedModelInfo: { supportsReasoning: true },
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { searchCommits: vi.fn(async () => ({ commits: [] })) },
	StateServiceClient: { togglePlanActModeProto: mocks.togglePlanActModeProto },
	ModelsServiceClient: { assignApiProfile: vi.fn(async () => ({})) },
	WorktreeServiceClient: {
		threadWorktreeAction: vi.fn(async () => ({
			json: JSON.stringify({
				state: {
					settings: { mode: "git", mmPath: "", nodePath: "node" },
					availability: { mode: "git", available: true, hasMmrc: false, workspaceOff: false },
					settled: [],
				},
			}),
		})),
	},
	TaskGroupServiceClient: { setThreadTaskGroup: vi.fn(async () => ({})) },
}))

/** Reports `width` for every observed element, as a real ResizeObserver would after layout. */
function stubRowWidth(width?: number) {
	vi.stubGlobal(
		"ResizeObserver",
		class ResizeObserver {
			constructor(private callback: ResizeObserverCallback) {}
			observe(target: Element) {
				if (width) {
					this.callback([{ target, borderBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry], this)
				}
			}
			unobserve() {}
			disconnect() {}
		},
	)
}

function renderComposer(usageIndicator?: ChatTextAreaProps["usageIndicator"], overrides: Partial<ChatTextAreaProps> = {}) {
	const props = {
		onSend: vi.fn(),
		onSelectFilesAndImages: vi.fn(),
		setInputValue: vi.fn(),
		...overrides,
	}
	render(
		<ChatTextArea
			inputValue=""
			placeholderText="Type a message"
			selectedFiles={[]}
			selectedImages={[]}
			sendingDisabled={false}
			setSelectedFiles={vi.fn()}
			setSelectedImages={vi.fn()}
			shouldDisableFilesAndImages={false}
			usageIndicator={usageIndicator}
			{...props}
		/>,
	)
	return props
}

const usageSlot = (
	renderMeter: (layout: ComposerRowLayout) => React.ReactNode = () => <span data-testid="usage-slot">ring</span>,
	hasCompactNudge = false,
) => ({ hasCompactNudge, render: renderMeter })

const follows = (a: HTMLElement, b: HTMLElement) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe("composer bottom row", () => {
	beforeEach(() => stubRowWidth())
	afterEach(() => {
		vi.unstubAllGlobals()
		mocks.inThread = false
		mocks.modKey = "⌘"
		mocks.togglePlanActModeProto.mockClear()
	})

	it("is 📎 on the left, then the ring, the Model · Effort chip and Send on the right", () => {
		mocks.inThread = true
		renderComposer(usageSlot())
		const row = screen.getByTestId("composer-bottom-row")
		const order = [
			screen.getByTestId("attach-button"),
			screen.getByTestId("usage-slot"),
			screen.getByTestId("model-effort-chip"),
			screen.getByTestId("send-split"),
		]
		for (const element of order) expect(row).toContainElement(element)
		for (let i = 1; i < order.length; i++) expect(follows(order[i - 1], order[i])).toBe(true)
		// No "·": the model and effort read as words, spaced by the chip's gap.
		expect(screen.getByTestId("model-effort-chip")).toHaveTextContent(/^GPT-6 Sol · Company gatewayMed$/)
		expect(screen.getByTestId("mode-switch")).toHaveTextContent(/^AskAct$/)
		expect(screen.getByTestId("mode-switch")).toHaveAttribute("aria-checked", "true")
		expect(follows(screen.getByTestId("model-effort-chip"), screen.getByTestId("mode-switch"))).toBe(true)
		expect(follows(screen.getByTestId("mode-switch"), screen.getByTestId("send-button"))).toBe(true)
	})

	it("sits inside the composer card with the text, which draws the focus border", () => {
		mocks.inThread = true
		renderComposer(usageSlot())
		const card = screen.getByTestId("composer-card")
		const input = screen.getByTestId("chat-input")
		const row = screen.getByTestId("composer-bottom-row")
		expect(card).toContainElement(input)
		expect(card).toContainElement(row)
		expect(follows(input, row)).toBe(true)
		// The textarea is borderless inside; the card's border takes the focus color.
		expect(input.style.outline).toBe("none")
		fireEvent.blur(input)
		expect(card).toHaveClass("border-input-border")
		expect(card).not.toHaveAttribute("data-focused")
		fireEvent.focus(input)
		expect(card).toHaveAttribute("data-focused", "true")
		expect(card.style.borderColor).toBe("var(--vscode-focusBorder)")
	})

	it("keeps the new thread's In … for … line under the card, not in it", () => {
		renderComposer()
		const card = screen.getByTestId("composer-card")
		const line = screen.getByTestId("new-thread-line")
		expect(card).not.toContainElement(line)
		expect(follows(card, line)).toBe(true)
	})

	it("no longer has ＋, MCP servers, rules, the shield or separate pickers; one switch, for the mode", () => {
		renderComposer(usageSlot())
		for (const id of [
			"plus-menu-button",
			"mcp-servers-button",
			"rules-button",
			"approvals-button",
			"composer-mode-controls",
			"composer-pickers",
			"context-button",
		]) {
			expect(screen.queryByTestId(id)).not.toBeInTheDocument()
		}
		expect(screen.getAllByRole("switch")).toEqual([screen.getByTestId("mode-switch")])
	})

	it("📎 opens the file picker", () => {
		const props = renderComposer()
		fireEvent.click(screen.getByTestId("attach-button"))
		expect(props.onSelectFilesAndImages).toHaveBeenCalledOnce()
	})

	it("📎 is disabled with its reason once the message holds the most files and images", () => {
		const props = renderComposer(undefined, { shouldDisableFilesAndImages: true })
		const attach = screen.getByTestId("attach-button")
		expect(attach).toHaveAttribute("aria-disabled", "true")
		expect(attach.title).toMatch(/Remove one to add another/)
		fireEvent.click(attach)
		expect(props.onSelectFilesAndImages).not.toHaveBeenCalled()
	})

	describe("new thread vs in a thread", () => {
		it("a new thread gets the In … for … line under the composer", () => {
			renderComposer()
			const line = screen.getByTestId("new-thread-line")
			expect(line).toHaveTextContent(/^In.*Your workspace.*for.*No task/)
			expect(within(line).getByTestId("workspace-button")).toBeInTheDocument()
			expect(within(line).getByTestId("where-pill")).toBeInTheDocument()
			// Below the row, not in it.
			expect(follows(screen.getByTestId("composer-bottom-row"), line)).toBe(true)
			expect(screen.getByTestId("composer-bottom-row")).not.toContainElement(screen.getByTestId("where-pill"))
		})

		it("inside a thread neither picker is in the composer (the header has them)", () => {
			mocks.inThread = true
			renderComposer(usageSlot())
			expect(screen.queryByTestId("new-thread-line")).toBeNull()
			expect(screen.queryByTestId("where-pill")).toBeNull()
			expect(screen.queryByTestId("workspace-button")).toBeNull()
		})
	})

	describe("Send carries the mode", () => {
		it("sends from the main part", () => {
			const props = renderComposer(undefined, { inputValue: "hi" })
			fireEvent.click(screen.getByTestId("send-button"))
			expect(props.onSend).toHaveBeenCalledOnce()
		})

		it("switches to Ask in one click on the mode switch", () => {
			renderComposer()
			fireEvent.click(screen.getByTestId("mode-switch"))
			expect(mocks.togglePlanActModeProto).toHaveBeenCalledWith(expect.objectContaining({ mode: PlanActMode.PLAN }))
		})

		it.each([
			["⌘", "⌘+Shift+A"],
			["Ctrl", "Ctrl+Shift+A"],
		])("shows the toggle shortcut with %s", (modKey, keys) => {
			mocks.modKey = modKey
			renderComposer()
			const shown = modKey === "⌘" ? "⌘⇧A" : keys
			expect(screen.getByTestId("mode-switch")).toHaveAccessibleName(`Mode: Act. Switch to Ask (${shown})`)
			expect(screen.getByTestId("mode-switch").title).toContain(`Switch to Ask (${shown})`)
		})

		it("keeps start-in-background on the home composer", () => {
			const onSendAs = vi.fn()
			renderComposer(undefined, { isHome: true, onSendAs, inputValue: "hi" })
			expect(screen.getByTestId("send-button").title).toContain("Start in background (⌘+Enter)")
			expect(screen.queryByTestId("send-background-button")).toBeNull()
			fireEvent.keyDown(screen.getByPlaceholderText("Type a message"), { key: "Enter", metaKey: true })
			expect(onSendAs).toHaveBeenCalledWith("background")
		})

		it("splits into steer and interject while running", () => {
			mocks.inThread = true
			const onSendAs = vi.fn()
			const props = renderComposer(undefined, { isRunning: true, onSendAs })
			expect(screen.queryByTestId("send-button")).toBeNull()
			fireEvent.click(screen.getByTestId("steer-button"))
			fireEvent.click(screen.getByTestId("interject-button"))
			expect(props.onSend).toHaveBeenCalledOnce()
			expect(onSendAs).toHaveBeenCalledWith("interject")
		})
	})

	describe("layout", () => {
		it("gives the meter the full layout before the row is measured", () => {
			const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
			renderComposer(usageSlot(renderMeter))
			expect(renderMeter).toHaveBeenLastCalledWith(FULL_COMPOSER_ROW)
		})

		it("drops the Compact label, then hides the effort word from the chip, on narrow rows", () => {
			stubRowWidth(275)
			const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
			renderComposer(usageSlot(renderMeter, true))
			expect(renderMeter).toHaveBeenLastCalledWith(
				composerRowLayout(275, { hasUsage: true, hasCompactNudge: true, hasEffort: true }),
			)
			expect(renderMeter).toHaveBeenLastCalledWith({ inlineCompactNudge: false, compactEffort: true, tightChip: false })
			expect(screen.getByTestId("model-effort-chip").closest("[data-shrink]")).toHaveAttribute("data-floor", "76")
			// The mode switch keeps both labels until the tightest row.
			expect(screen.getByTestId("mode-switch")).not.toHaveAttribute("data-compact")
			// The chip is one button: the effort word is gone from its text, but it still names the effort.
			const chip = screen.getByTestId("model-effort-chip")
			expect(chip).toHaveTextContent(/^GPT-6 Sol · Company gateway$/)
			expect(screen.queryByTestId("chip-effort")).toBeNull()
			expect(chip).toHaveAccessibleName(/effort Medium/)
		})

		it("goes tight only after the effort text is gone", () => {
			stubRowWidth(225)
			const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
			renderComposer(usageSlot(renderMeter, true))
			expect(renderMeter).toHaveBeenLastCalledWith({ inlineCompactNudge: false, compactEffort: true, tightChip: true })
			expect(screen.getByTestId("model-effort-chip").closest("[data-shrink]")).toHaveAttribute("data-floor", "56")
			// The mode switch goes compact with it: the current mode only.
			expect(screen.getByTestId("mode-switch")).toHaveAttribute("data-compact", "true")
			expect(screen.getByTestId("mode-switch")).toHaveTextContent(/^Act$/)
		})

		it("gives Send the room on the narrowest rows: the model name goes, then the mode switch", () => {
			stubRowWidth(150)
			renderComposer()
			expect(screen.queryByTestId("chip-model")).toBeNull()
			expect(screen.getByTestId("mode-switch")).toBeInTheDocument()
			expect(screen.getByTestId("send-button")).toBeInTheDocument()
			// The chip is still one button that names the model.
			expect(screen.getByTestId("model-effort-chip")).toHaveAccessibleName(/GPT-6 Sol/)
		})

		it("keeps Send and drops the switch at VS Code's narrowest sidebar", () => {
			stubRowWidth(143)
			renderComposer(usageSlot(() => <span data-testid="usage-slot">ring</span>, true))
			expect(screen.queryByTestId("mode-switch")).toBeNull()
			expect(screen.getByTestId("send-button")).toBeInTheDocument()
			expect(screen.getByTestId("send-split")).toHaveAttribute("data-mode", "act")
			expect(screen.getByTestId("model-effort-chip").closest("[data-shrink]")).toHaveAttribute("data-floor", "0")
		})

		it("lays the row out in normal flow, the meter beside the chip", () => {
			renderComposer(usageSlot())
			const row = screen.getByTestId("composer-bottom-row")
			expect(row).toHaveClass("flex", "flex-nowrap")
			const slot = screen.getByTestId("composer-usage")
			expect(slot).toHaveClass("shrink-0")
			expect(slot.parentElement).toBe(row)
		})

		it("omits the meter slot on the home composer", () => {
			renderComposer()
			expect(screen.queryByTestId("composer-usage")).not.toBeInTheDocument()
			expect(screen.getByTestId("model-effort-chip")).toBeInTheDocument()
		})
	})

	describe("before the model settings store exists", () => {
		const { modelSettings, selected } = mocks
		afterEach(() => {
			mocks.modelSettings = modelSettings
			mocks.selected = selected
		})

		it("names the model on the chip, not a provider-prefixed id", () => {
			mocks.modelSettings = undefined
			mocks.selected = { selectedProvider: "openai", selectedModelId: "mig-high" }
			renderComposer()
			expect(screen.getByTestId("chip-model")).toHaveTextContent(/^mig-high$/)
			expect(screen.getByTestId("model-effort-chip")).toHaveAccessibleName(/model: mig-high/)
		})
	})

	it("starts a script draft when the rules overlay asks for one", () => {
		const props = renderComposer()
		act(() => {
			document.dispatchEvent(new CustomEvent(USE_SCRIPT_EVENT, { detail: "deploy" }))
		})
		expect(props.setInputValue).toHaveBeenCalledWith("/deploy ")
	})
})
