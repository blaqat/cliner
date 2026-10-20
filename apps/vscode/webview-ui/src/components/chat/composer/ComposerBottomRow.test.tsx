import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { fireEvent, render, screen, within } from "@testing-library/react"
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
		// Reasoning, so the effort picker shows next to the configuration picker.
		selectedModelInfo: { supportsReasoning: true },
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

	it("is ＋, MCP servers, rules, where, configuration, effort, the approvals shield, then the meter and the Ask/Act switch", () => {
		renderComposer(usageSlot())
		const group = screen.getByTestId("composer-pickers")
		const order = [
			screen.getByTestId("plus-menu-button"),
			screen.getByTestId("mcp-servers-button"),
			screen.getByTestId("rules-button"),
			screen.getByTestId("where-pill"),
			screen.getByTestId("config-picker"),
			screen.getByTestId("reasoning-effort-picker"),
			screen.getByTestId("approvals-button"),
		]
		for (const element of order) {
			expect(group).toContainElement(element)
		}
		for (const element of [...order, screen.getByTestId("usage-slot"), screen.getByTestId("mode-switch")].reduce<
			HTMLElement[][]
		>((pairs, element, i, all) => (i > 0 ? [...pairs, [all[i - 1], element]] : pairs), [])) {
			expect(element[0].compareDocumentPosition(element[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		}
		// The shield closes the picker group, right after the model and effort chips.
		const shield = screen.getByTestId("approvals-button")
		expect(shield.parentElement).toBe(group)
		expect(group.lastElementChild).toBe(shield)
		expect(shield.previousElementSibling).toContainElement(screen.getByTestId("reasoning-effort-picker"))
	})

	it("keeps the MCP servers and rules buttons out of the ＋ menu while they're beside it", () => {
		stubRowWidth(600)
		renderComposer(usageSlot())
		fireEvent.click(screen.getByTestId("plus-menu-button"))
		const menu = screen.getByTestId("plus-menu")
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.getAttribute("data-testid")),
		).toEqual(["plus-menu-mention", "plus-menu-files"])
	})

	it("the MCP servers and rules buttons open their panels in popovers", () => {
		stubRowWidth(600)
		renderComposer(usageSlot())
		fireEvent.click(screen.getByRole("button", { name: "MCP servers" }))
		expect(screen.getByTestId("mcp-servers")).toBeInTheDocument()
		fireEvent.keyDown(screen.getByTestId("mcp-servers"), { key: "Escape" })
		expect(screen.queryByTestId("mcp-servers")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Rules, workflows, skills & scripts" }))
		expect(screen.getByTestId("rules")).toBeInTheDocument()
	})

	it("no longer has separate @ or files buttons, an overflow button, nor a merged model pill", () => {
		renderComposer(usageSlot())
		for (const id of ["context-button", "files-button", "picker-overflow-button", "model-effort-pill"]) {
			expect(screen.queryByTestId(id)).not.toBeInTheDocument()
		}
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

	it("folds the MCP servers and rules buttons into ＋ at narrow widths, keeping every other control", () => {
		stubRowWidth(320)
		const renderMeter = vi.fn((_layout: ComposerRowLayout) => null)
		renderComposer(usageSlot(renderMeter))
		expect(renderMeter).toHaveBeenLastCalledWith(
			composerRowLayout(320, { hasUsage: true, hasCost: true, hasCompactNudge: true, hasEffort: true }),
		)
		expect(renderMeter).toHaveBeenLastCalledWith({ inlinePanelButtons: false, showCost: false, inlineCompactNudge: false })
		for (const id of [
			"plus-menu-button",
			"where-pill",
			"config-picker",
			"reasoning-effort-picker",
			"approvals-button",
			"mode-switch",
		]) {
			expect(screen.getByTestId(id)).toBeInTheDocument()
		}
		expect(screen.queryByTestId("mcp-servers-button")).not.toBeInTheDocument()
		expect(screen.queryByTestId("rules-button")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("plus-menu-button"))
		fireEvent.click(screen.getByTestId("plus-menu-mcp"))
		expect(screen.getByTestId("plus-menu")).toBeInTheDocument()
		expect(screen.getByTestId("plus-menu-back")).toBeInTheDocument()
	})

	it.each([
		[600, true],
		[480, true],
		[440, false],
		[360, false],
	])("at %ipx the MCP servers and rules buttons are inline: %s", (width, inline) => {
		stubRowWidth(width)
		renderComposer(usageSlot())
		expect(!!screen.queryByTestId("mcp-servers-button")).toBe(inline)
		expect(!!screen.queryByTestId("rules-button")).toBe(inline)
		fireEvent.click(screen.getByTestId("plus-menu-button"))
		expect(!!screen.queryByTestId("plus-menu-mcp")).toBe(!inline)
		expect(!!screen.queryByTestId("plus-menu-rules")).toBe(!inline)
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
