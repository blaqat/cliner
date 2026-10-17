import { fireEvent, render, screen, within } from "@testing-library/react"
import type React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import PlusMenu from "./PlusMenu"

const mocks = vi.hoisted(() => ({
	getLatestMcpServers: vi.fn(),
	refreshRules: vi.fn(),
	setMcpServers: vi.fn(),
	navigateToMcp: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		...mocks.state,
		setMcpServers: mocks.setMcpServers,
		navigateToMcp: mocks.navigateToMcp,
		setGlobalClineRulesToggles: vi.fn(),
		setLocalClineRulesToggles: vi.fn(),
		setLocalCursorRulesToggles: vi.fn(),
		setLocalWindsurfRulesToggles: vi.fn(),
		setLocalAgentsRulesToggles: vi.fn(),
		setLocalWorkflowToggles: vi.fn(),
		setGlobalWorkflowToggles: vi.fn(),
		setGlobalSkillsToggles: vi.fn(),
		setLocalSkillsToggles: vi.fn(),
		setRemoteRulesToggles: vi.fn(),
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	McpServiceClient: { getLatestMcpServers: (request: unknown) => mocks.getLatestMcpServers(request) },
	FileServiceClient: {
		refreshRules: (request: unknown) => mocks.refreshRules(request),
		refreshHooks: vi.fn(async () => ({})),
		refreshSkills: vi.fn(async () => ({})),
	},
}))

vi.mock("@/hooks/useRemoteConfigSettings", () => ({
	default: () => ({ settings: [], isLoading: false }),
}))

// The server rows are the MCP settings page's; the menu only has to host them.
vi.mock("@/components/mcp/configuration/tabs/installed/ServersToggleList", () => ({
	default: ({ servers }: { servers: { name: string }[] }) => (
		<ul data-testid="servers-toggle-list">
			{servers.map((server) => (
				<li key={server.name}>{server.name}</li>
			))}
		</ul>
	),
}))

const SERVERS = [{ name: "github" }, { name: "linear", disabled: true }, { name: "sentry" }]

function renderMenu(props: Partial<React.ComponentProps<typeof PlusMenu>> = {}) {
	const handlers = { onMention: vi.fn(), onAddFiles: vi.fn() }
	render(<PlusMenu filesDisabled={false} {...handlers} {...props} />)
	return handlers
}

function openMenu() {
	fireEvent.click(screen.getByTestId("plus-menu-button"))
	return screen.getByTestId("plus-menu")
}

describe("PlusMenu", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.getLatestMcpServers.mockReset().mockResolvedValue({ mcpServers: [] })
		mocks.refreshRules.mockReset().mockResolvedValue({})
		mocks.setMcpServers.mockReset()
		mocks.navigateToMcp.mockReset()
		mocks.state = {
			mcpServers: SERVERS,
			globalClineRulesToggles: { "/home/me/.clinerules/style.md": true, "/home/me/.clinerules/old.md": false },
			localClineRulesToggles: { "/repo/.clinerules/repo.md": true },
			localCursorRulesToggles: {},
		}
	})

	it("is a labelled button that opens a menu of everything it holds", () => {
		renderMenu()
		expect(screen.getByRole("button", { name: "Add context, files, MCP servers and rules" })).toBeInTheDocument()
		const menu = openMenu()
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.textContent),
		).toEqual(["@Mention a file, folder or problem", "Files & images", "MCP servers2 on", "Rules, workflows & skills2 on"])
		// No scripts until step 7 fills the slot.
		expect(within(menu).queryByTestId("plus-menu-scripts")).not.toBeInTheDocument()
	})

	it("Mention closes the menu and inserts @ through the composer", () => {
		const { onMention } = renderMenu()
		openMenu()
		fireEvent.click(screen.getByTestId("plus-menu-mention"))
		expect(onMention).toHaveBeenCalledOnce()
		expect(screen.queryByTestId("plus-menu")).not.toBeInTheDocument()
	})

	it("Files & images closes the menu and uses the composer's handler", () => {
		const { onAddFiles } = renderMenu()
		openMenu()
		fireEvent.click(screen.getByTestId("plus-menu-files"))
		expect(onAddFiles).toHaveBeenCalledOnce()
		expect(screen.queryByTestId("plus-menu")).not.toBeInTheDocument()
	})

	it("disables Files & images when attachments are disabled", () => {
		const { onAddFiles } = renderMenu({ filesDisabled: true })
		openMenu()
		expect(screen.getByTestId("plus-menu-files")).toBeDisabled()
		fireEvent.click(screen.getByTestId("plus-menu-files"))
		expect(onAddFiles).not.toHaveBeenCalled()
	})

	it("shows the MCP server toggles inline, refreshes them, and goes back", () => {
		renderMenu()
		openMenu()
		fireEvent.click(screen.getByTestId("plus-menu-mcp"))

		const panel = screen.getByTestId("mcp-servers-panel")
		expect(screen.getByTestId("plus-menu")).toContainElement(panel)
		expect(within(panel).getByTestId("servers-toggle-list")).toHaveTextContent("githublinearsentry")
		expect(mocks.getLatestMcpServers).toHaveBeenCalledOnce()
		expect(screen.queryByRole("dialog", { name: /MCP/ })).not.toBeInTheDocument()

		fireEvent.click(screen.getByTestId("plus-menu-back"))
		expect(screen.queryByTestId("mcp-servers-panel")).not.toBeInTheDocument()
		expect(screen.getByTestId("plus-menu-mcp")).toBeInTheDocument()
	})

	it("MCP server settings closes the menu and opens the MCP page", () => {
		renderMenu()
		openMenu()
		fireEvent.click(screen.getByTestId("plus-menu-mcp"))
		fireEvent.click(screen.getByRole("button", { name: /MCP server settings/ }))
		expect(mocks.navigateToMcp).toHaveBeenCalledWith("configure")
		expect(screen.queryByTestId("plus-menu")).not.toBeInTheDocument()
	})

	it("shows the rules, workflows and skills toggles inline and refreshes them from disk", () => {
		renderMenu()
		openMenu()
		fireEvent.click(screen.getByTestId("plus-menu-rules"))

		const panel = screen.getByTestId("rules-panel")
		expect(screen.getByTestId("plus-menu")).toContainElement(panel)
		expect(within(panel).getByRole("button", { name: "Rules" })).toBeInTheDocument()
		expect(within(panel).getByRole("button", { name: "Workflows" })).toBeInTheDocument()
		expect(within(panel).getByRole("button", { name: "Skills" })).toBeInTheDocument()
		expect(panel).toHaveTextContent("style.md")
		expect(mocks.refreshRules).toHaveBeenCalledOnce()
	})

	it("opens a submenu with ArrowRight and moves with the arrow keys", () => {
		renderMenu()
		openMenu()
		const mention = screen.getByTestId("plus-menu-mention")
		mention.focus()
		fireEvent.keyDown(mention, { key: "ArrowDown" })
		expect(screen.getByTestId("plus-menu-files")).toHaveFocus()
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" })
		expect(screen.getByTestId("plus-menu-mcp")).toHaveFocus()
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" })
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" })
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" })
		expect(screen.getByTestId("plus-menu-rules")).toHaveFocus()
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" })
		expect(screen.getByTestId("rules-panel")).toBeInTheDocument()
	})

	it("closes on Escape from the list", () => {
		renderMenu()
		openMenu()
		fireEvent.keyDown(screen.getByTestId("plus-menu"), { key: "Escape" })
		expect(screen.queryByTestId("plus-menu")).not.toBeInTheDocument()
	})

	it.each([
		["mcp", "mcp-servers-panel"],
		["rules", "rules-panel"],
	])("Escape in the %s panel goes back to the list, and a second Escape closes", (view, panelId) => {
		renderMenu()
		openMenu()
		fireEvent.click(screen.getByTestId(`plus-menu-${view}`))
		fireEvent.keyDown(screen.getByTestId(panelId), { key: "Escape" })

		expect(screen.queryByTestId(panelId)).not.toBeInTheDocument()
		expect(screen.getByTestId("plus-menu")).toBeInTheDocument()
		expect(screen.getByTestId(`plus-menu-${view}`)).toHaveFocus()

		fireEvent.keyDown(document.activeElement as Element, { key: "Escape" })
		expect(screen.queryByTestId("plus-menu")).not.toBeInTheDocument()
		// Reopening starts at the list, not the last panel.
		openMenu()
		expect(screen.getByTestId("plus-menu-mention")).toBeInTheDocument()
	})

	it("Back returns focus to the panel's row", () => {
		renderMenu()
		openMenu()
		fireEvent.click(screen.getByTestId("plus-menu-rules"))
		fireEvent.click(screen.getByTestId("plus-menu-back"))
		expect(screen.getByTestId("plus-menu-rules")).toHaveFocus()
	})

	it("shows Scripts once the slot is filled, opening its panel inline", () => {
		renderMenu({ scripts: { summary: "4 saved", panel: <div data-testid="scripts-panel">scripts</div> } })
		openMenu()
		expect(screen.getByTestId("plus-menu-scripts")).toHaveTextContent("Scripts4 saved")
		fireEvent.click(screen.getByTestId("plus-menu-scripts"))
		expect(screen.getByTestId("plus-menu")).toContainElement(screen.getByTestId("scripts-panel"))
	})
})
