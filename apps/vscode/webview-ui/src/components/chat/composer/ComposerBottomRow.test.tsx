import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { fireEvent, render, screen } from "@testing-library/react"
import type React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import ChatTextArea, { type ChatTextAreaProps } from "../ChatTextArea"
import { type ComposerRowLayout, composerRowLayout, FULL_COMPOSER_ROW } from "./composerRowLayout"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mode: "act",
		apiConfiguration: {},
		platform: "darwin",
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		remoteWorkflowToggles: {},
		mcpServers: [],
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
	}),
}))

vi.mock("@/context/PlatformContext", () => ({
	usePlatform: () => ({ togglePlanActKeys: "Meta+Shift+a" }),
}))

vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		selectedProvider: "anthropic",
		selectedModelId: "model",
		selectedModelInfo: {},
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { searchCommits: vi.fn(async () => ({ commits: [] })) },
	StateServiceClient: { togglePlanActModeProto: vi.fn(async () => ({})) },
}))

vi.mock("../../cline-rules/ClineRulesToggleModal", () => ({ default: () => null }))
vi.mock("../ServersToggleModal", () => ({ default: () => null }))

/** Reports `width` for every observed element, as a real ResizeObserver would after layout. */
function stubRowWidth(width: number) {
	vi.stubGlobal(
		"ResizeObserver",
		class ResizeObserver {
			constructor(private callback: ResizeObserverCallback) {}
			observe(target: Element) {
				this.callback([{ target, borderBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry], this)
			}
			unobserve() {}
			disconnect() {}
		},
	)
}

function renderComposer(usageIndicator?: ChatTextAreaProps["usageIndicator"]) {
	render(
		<ChatTextArea
			inputValue=""
			onSelectFilesAndImages={vi.fn()}
			onSend={vi.fn()}
			placeholderText="Type a message"
			selectedFiles={[]}
			selectedImages={[]}
			sendingDisabled={false}
			setInputValue={vi.fn()}
			setSelectedFiles={vi.fn()}
			setSelectedImages={vi.fn()}
			shouldDisableFilesAndImages={false}
			usageIndicator={usageIndicator}
		/>,
	)
}

const usageSlot = (
	renderMeter: (layout: ComposerRowLayout) => React.ReactNode = () => <span data-testid="usage-slot">ring</span>,
) => ({ hasCost: true, hasCompactNudge: true, render: renderMeter })

describe("composer bottom row", () => {
	afterEach(() => vi.unstubAllGlobals())

	it("puts the approvals shield in the picker group with the config picker", () => {
		renderComposer()
		const group = screen.getByTestId("composer-pickers")
		expect(group).toContainElement(screen.getByTestId("approvals-button"))
		expect(group).toContainElement(screen.getByTestId("config-picker"))
		expect(screen.queryByTestId("picker-overflow-button")).not.toBeInTheDocument()
	})

	it("lays the row out in normal flow: pickers, then the meter, then the Ask/Act toggle", () => {
		renderComposer(usageSlot())
		const row = screen.getByTestId("composer-bottom-row")
		expect(row).toHaveClass("flex", "flex-nowrap")
		const slot = screen.getByTestId("usage-slot").parentElement as HTMLElement
		expect(slot).toHaveClass("shrink-0")
		expect(slot.parentElement).toBe(row)
		expect(slot.contains(screen.getByTestId("approvals-button"))).toBe(false)
		expect(slot.compareDocumentPosition(screen.getByTestId("mode-switch")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		// Nothing is absolutely positioned on top of the meter any more.
		expect(screen.getByTestId("composer-pickers").className).not.toMatch(/\babsolute\b/)
	})

	it("omits the meter slot on the home composer", () => {
		renderComposer()
		expect(screen.queryByTestId("usage-slot")).not.toBeInTheDocument()
	})

	it("gives the meter the full layout before the row is measured", () => {
		const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
		renderComposer(usageSlot(renderMeter))
		expect(renderMeter).toHaveBeenLastCalledWith(FULL_COMPOSER_ROW)
	})

	it("collapses by the measured row width", () => {
		stubRowWidth(320)
		const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
		renderComposer(usageSlot(renderMeter))
		expect(renderMeter).toHaveBeenLastCalledWith(
			composerRowLayout(320, { hasUsage: true, hasCost: true, hasCompactNudge: true, hasEffort: false }),
		)
		expect(renderMeter).toHaveBeenLastCalledWith(expect.objectContaining({ showCost: false, inlineCompactNudge: false }))
	})

	it("folds the pickers into the … menu at narrow widths", () => {
		stubRowWidth(250)
		renderComposer(usageSlot())
		expect(screen.queryByTestId("approvals-button")).not.toBeInTheDocument()
		expect(screen.queryByTestId("config-picker")).not.toBeInTheDocument()
		expect(screen.getByTestId("composer-bottom-row")).toHaveAttribute("data-collapse-pickers", "true")

		fireEvent.click(screen.getByTestId("picker-overflow-button"))
		const menu = screen.getByTestId("picker-overflow-menu")
		expect(menu).toContainElement(screen.getByTestId("approvals-button"))
		expect(menu).toContainElement(screen.getByTestId("config-picker"))
	})
})
