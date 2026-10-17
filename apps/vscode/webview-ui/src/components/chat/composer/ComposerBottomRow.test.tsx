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

vi.mock("../../cline-rules/ClineRulesPanel", () => ({ default: () => null }))
vi.mock("./McpServersPanel", () => ({ default: () => null }))

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

function renderComposer(usageIndicator?: ChatTextAreaProps["usageIndicator"], overrides: Partial<ChatTextAreaProps> = {}) {
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
			{...overrides}
		/>,
	)
}

const usageSlot = (
	renderMeter: (layout: ComposerRowLayout) => React.ReactNode = () => <span data-testid="usage-slot">ring</span>,
) => ({ hasCost: true, hasCompactNudge: true, render: renderMeter })

describe("composer bottom row", () => {
	afterEach(() => vi.unstubAllGlobals())

	it("is ＋, where, model + effort, then the meter, the approvals shield and the Ask/Act switch", () => {
		renderComposer(usageSlot())
		const row = screen.getByTestId("composer-bottom-row")
		const group = screen.getByTestId("composer-pickers")
		expect(group).toContainElement(screen.getByTestId("plus-menu-button"))
		expect(group).toContainElement(screen.getByTestId("where-pill"))
		expect(group).toContainElement(screen.getByTestId("model-effort-pill"))
		expect(group).not.toContainElement(screen.getByTestId("approvals-button"))

		const order = [
			screen.getByTestId("plus-menu-button"),
			screen.getByTestId("where-pill"),
			screen.getByTestId("model-effort-pill"),
			screen.getByTestId("usage-slot"),
			screen.getByTestId("approvals-button"),
			screen.getByTestId("mode-switch"),
		]
		for (let i = 1; i < order.length; i++) {
			expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		}
		// The shield sits right before the switch, outside the meter.
		const shield = screen.getByTestId("approvals-button")
		expect(shield.parentElement).toBe(row)
		expect(shield.nextElementSibling?.contains(screen.getByTestId("mode-switch"))).toBe(true)
	})

	it("no longer has separate @, files, MCP, rules, effort or overflow buttons", () => {
		renderComposer(usageSlot())
		for (const id of [
			"context-button",
			"files-button",
			"reasoning-effort-picker",
			"picker-overflow-button",
			"config-picker",
		]) {
			expect(screen.queryByTestId(id)).not.toBeInTheDocument()
		}
		expect(screen.queryByRole("button", { name: /MCP Servers|Customize/ })).not.toBeInTheDocument()
	})

	it("lays the row out in normal flow", () => {
		renderComposer(usageSlot())
		const row = screen.getByTestId("composer-bottom-row")
		expect(row).toHaveClass("flex", "flex-nowrap")
		const slot = screen.getByTestId("usage-slot").parentElement as HTMLElement
		expect(slot).toHaveClass("shrink-0")
		expect(slot.parentElement).toBe(row)
		// Nothing is absolutely positioned on top of the meter.
		expect(screen.getByTestId("composer-pickers").className).not.toMatch(/\babsolute\b/)
	})

	it("omits the meter slot on the home composer", () => {
		renderComposer()
		expect(screen.queryByTestId("usage-slot")).not.toBeInTheDocument()
		expect(screen.getByTestId("approvals-button")).toBeInTheDocument()
	})

	it("gives the meter the full layout before the row is measured", () => {
		const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
		renderComposer(usageSlot(renderMeter))
		expect(renderMeter).toHaveBeenLastCalledWith(FULL_COMPOSER_ROW)
	})

	it("hides the meter's extras by the measured row width, keeping every control", () => {
		stubRowWidth(320)
		const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
		renderComposer(usageSlot(renderMeter))
		expect(renderMeter).toHaveBeenLastCalledWith(
			composerRowLayout(320, { hasUsage: true, hasCost: true, hasCompactNudge: true }),
		)
		expect(renderMeter).toHaveBeenLastCalledWith({ showCost: false, inlineCompactNudge: false })
		for (const id of ["plus-menu-button", "where-pill", "model-effort-pill", "approvals-button", "mode-switch"]) {
			expect(screen.getByTestId(id)).toBeInTheDocument()
		}
	})

	it("Mention in the ＋ menu inserts @ and opens the mention menu", () => {
		stubRowWidth(400)
		const setInputValue = vi.fn()
		renderComposer(undefined, { setInputValue })
		fireEvent.click(screen.getByTestId("plus-menu-button"))
		fireEvent.click(screen.getByTestId("plus-menu-mention"))
		expect(setInputValue).toHaveBeenCalledWith("@")
		expect(screen.getByTestId("chat-input")).toHaveFocus()
	})

	it("Files & images in the ＋ menu opens the file picker", () => {
		stubRowWidth(400)
		const onSelectFilesAndImages = vi.fn()
		renderComposer(undefined, { onSelectFilesAndImages })
		fireEvent.click(screen.getByTestId("plus-menu-button"))
		fireEvent.click(screen.getByTestId("plus-menu-files"))
		expect(onSelectFilesAndImages).toHaveBeenCalledOnce()
	})
})
