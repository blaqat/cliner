import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { PlanActMode } from "@shared/proto/cline/state"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
	apiConfigProfiles: [{ id: "p1", name: "Opus 4.5", provider: "anthropic", modelId: "claude-opus" }],
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mode: "act",
		apiConfiguration: { actModeReasoningEffort: "high" },
		apiConfigProfiles: mocks.apiConfigProfiles,
		actProfileId: "p1",
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
		selectedProvider: "anthropic",
		selectedModelId: "model",
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
		expect(screen.getByTestId("model-effort-chip")).toHaveTextContent("Opus 4.5·High")
		expect(screen.getByTestId("send-button")).toHaveTextContent(/^Act$/)
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

	it("no longer has ＋, MCP servers, rules, the shield, the Ask/Act switch or separate pickers", () => {
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
		expect(screen.queryAllByRole("switch")).toHaveLength(0)
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

		it("switches to Ask from the ⌄ menu", () => {
			renderComposer()
			fireEvent.click(screen.getByTestId("mode-switch"))
			fireEvent.click(screen.getByTestId("mode-option-plan"))
			expect(mocks.togglePlanActModeProto).toHaveBeenCalledWith(expect.objectContaining({ mode: PlanActMode.PLAN }))
		})

		it.each([
			["⌘", "⌘+Shift+A"],
			["Ctrl", "Ctrl+Shift+A"],
		])("shows the toggle shortcut with %s", (modKey, keys) => {
			mocks.modKey = modKey
			renderComposer()
			expect(screen.getByTestId("mode-switch")).toHaveAccessibleName(`Mode: Act. Switch Ask/Act (${keys})`)
			fireEvent.click(screen.getByTestId("mode-switch"))
			expect(screen.getByTestId("mode-shortcut")).toHaveTextContent(keys)
		})

		it("keeps start-in-background on the home composer", () => {
			const onSendAs = vi.fn()
			renderComposer(undefined, { isHome: true, onSendAs, inputValue: "hi" })
			expect(screen.getByTestId("send-button").title).toContain("Start in background (⌘+Enter)")
			fireEvent.click(screen.getByTestId("send-background-button"))
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

		it("drops the Compact label, then folds the effort text into ⌄, on narrow rows", () => {
			stubRowWidth(260)
			const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
			renderComposer(usageSlot(renderMeter, true))
			expect(renderMeter).toHaveBeenLastCalledWith(
				composerRowLayout(260, { hasUsage: true, hasCompactNudge: true, hasEffort: true }),
			)
			expect(renderMeter).toHaveBeenLastCalledWith({ inlineCompactNudge: false, compactEffort: true, tightChip: false })
			expect(screen.getByTestId("model-effort-chip").closest("[data-shrink]")).toHaveAttribute("data-floor", "76")
			// The effort still opens from its ⌄, and says what it is.
			const effort = screen.getByTestId("reasoning-effort-picker")
			expect(effort).toHaveTextContent(/^$/)
			expect(effort).toHaveAttribute("aria-label", expect.stringMatching(/^Reasoning effort: /))
		})

		it("goes tight only after the effort text is gone", () => {
			stubRowWidth(200)
			const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
			renderComposer(usageSlot(renderMeter, true))
			expect(renderMeter).toHaveBeenLastCalledWith({ inlineCompactNudge: false, compactEffort: true, tightChip: true })
			expect(screen.getByTestId("model-effort-chip").closest("[data-shrink]")).toHaveAttribute("data-floor", "56")
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

	it("starts a script draft when the rules overlay asks for one", () => {
		const props = renderComposer()
		act(() => {
			document.dispatchEvent(new CustomEvent(USE_SCRIPT_EVENT, { detail: "deploy" }))
		})
		expect(props.setInputValue).toHaveBeenCalledWith("/deploy ")
	})
})
