import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TopBarPanelOverlay } from "./TopBarPanelOverlay"
import { openTopBarPanel, USE_SCRIPT_EVENT } from "./topBarPanels"

vi.mock("@/components/chat/composer/McpServersPanel", () => ({
	default: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
		<div data-testid="mcp-servers-panel">
			<button onClick={onOpenSettings} type="button">
				MCP server settings…
			</button>
		</div>
	),
}))
vi.mock("@/components/cline-rules/ClineRulesPanel", () => ({
	default: ({ onUseScript }: { onUseScript: (name: string) => void }) => (
		<div data-testid="rules-panel">
			<button onClick={() => onUseScript("deploy")} type="button">
				Use
			</button>
		</div>
	),
}))

const open = (panel: "mcp" | "rules") => act(() => openTopBarPanel(panel))

describe("TopBarPanelOverlay", () => {
	afterEach(() => act(() => openTopBarPanel(null)))

	it("shows nothing until a title bar button opens a panel", () => {
		render(<TopBarPanelOverlay />)
		expect(screen.queryByTestId("top-bar-panel")).toBeNull()
		open("mcp")
		expect(screen.getByRole("dialog", { name: "MCP servers" })).toBeInTheDocument()
		expect(screen.getByTestId("mcp-servers-panel")).toBeInTheDocument()
	})

	it("opens Rules & workflows and closes with Escape", () => {
		render(<TopBarPanelOverlay />)
		open("rules")
		expect(screen.getByRole("dialog", { name: "Rules & workflows" })).toBeInTheDocument()
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("closes with ✕ and keeps focus inside while open", () => {
		render(<TopBarPanelOverlay />)
		open("mcp")
		const dialog = screen.getByRole("dialog")
		expect(dialog).toContainElement(document.activeElement as HTMLElement)
		fireEvent.click(screen.getByTestId("top-bar-panel-close"))
		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("returns focus to where it was", async () => {
		render(
			<>
				<button type="button">composer</button>
				<TopBarPanelOverlay />
			</>,
		)
		const before = screen.getByRole("button", { name: "composer" })
		before.focus()
		open("rules")
		fireEvent.click(screen.getByTestId("top-bar-panel-close"))
		await waitFor(() => expect(before).toHaveFocus())
	})

	it("closes on a backdrop click", async () => {
		render(<TopBarPanelOverlay />)
		open("mcp")
		// Radix starts listening for outside presses a tick after opening.
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
		const backdrop = screen.getByTestId("top-bar-panel-backdrop")
		fireEvent.pointerDown(backdrop)
		fireEvent.pointerUp(backdrop)
		fireEvent.click(backdrop)
		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("reaches the full MCP page and hands a script to the composer, closing as it goes", () => {
		const onUseScript = vi.fn()
		document.addEventListener(USE_SCRIPT_EVENT, onUseScript)
		render(<TopBarPanelOverlay />)
		open("mcp")
		fireEvent.click(screen.getByRole("button", { name: "MCP server settings…" }))
		expect(screen.queryByRole("dialog")).toBeNull()
		open("rules")
		fireEvent.click(screen.getByRole("button", { name: "Use" }))
		expect(screen.queryByRole("dialog")).toBeNull()
		expect((onUseScript.mock.calls[0][0] as CustomEvent<string>).detail).toBe("deploy")
		document.removeEventListener(USE_SCRIPT_EVENT, onUseScript)
	})
})
