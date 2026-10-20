import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { McpServersButton, RulesButton } from "./ComposerPanelButtons"

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

describe("composer panel buttons", () => {
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
		mocks.navigateToMcp.mockReset()
		mocks.state = {
			mcpServers: SERVERS,
			globalClineRulesToggles: { "/home/me/.clinerules/style.md": true },
			localClineRulesToggles: {},
		}
	})

	it("MCP servers is a labelled icon button that opens the server toggles in a popover", () => {
		render(<McpServersButton />)
		const button = screen.getByRole("button", { name: "MCP servers" })
		expect(button).toHaveAttribute("aria-haspopup", "dialog")
		expect(button.querySelector(".codicon-server")).not.toBeNull()
		expect(screen.queryByTestId("mcp-servers-panel")).not.toBeInTheDocument()

		fireEvent.click(button)
		const popover = screen.getByTestId("mcp-servers")
		expect(popover).toContainElement(screen.getByTestId("mcp-servers-panel"))
		expect(within(popover).getByTestId("servers-toggle-list")).toHaveTextContent("githublinearsentry")
		expect(mocks.getLatestMcpServers).toHaveBeenCalledOnce()
		expect(button).toHaveAttribute("aria-expanded", "true")
	})

	it("MCP server settings closes the popover and opens the MCP page", () => {
		render(<McpServersButton />)
		fireEvent.click(screen.getByTestId("mcp-servers-button"))
		fireEvent.click(screen.getByRole("button", { name: /MCP server settings/ }))
		expect(mocks.navigateToMcp).toHaveBeenCalledWith("configure")
		expect(screen.queryByTestId("mcp-servers")).not.toBeInTheDocument()
	})

	it("rules is a labelled icon button that opens rules, workflows, skills and scripts", () => {
		render(<RulesButton onUseScript={vi.fn()} />)
		const button = screen.getByRole("button", { name: "Rules, workflows, skills & scripts" })
		expect(button.querySelector(".codicon-law")).not.toBeNull()
		fireEvent.click(button)
		const panel = screen.getByTestId("rules-panel")
		expect(screen.getByTestId("rules")).toContainElement(panel)
		for (const tab of ["Rules", "Skills", "Workflows", "Scripts"]) {
			expect(within(panel).getByRole("button", { name: tab })).toBeInTheDocument()
		}
		expect(panel).toHaveTextContent("style.md")
		expect(mocks.refreshRules).toHaveBeenCalledOnce()
		fireEvent.click(within(panel).getByRole("button", { name: "Scripts" }))
		expect(screen.getByTestId("scripts-panel")).toBeInTheDocument()
	})

	it.each([
		["MCP servers", () => <McpServersButton />, "mcp-servers"],
		["rules", () => <RulesButton onUseScript={vi.fn()} />, "rules"],
	])("Escape closes the %s popover and returns focus to its button", async (_name, element, testId) => {
		render(element())
		const button = screen.getByTestId(`${testId}-button`)
		button.focus()
		fireEvent.click(button)
		fireEvent.keyDown(screen.getByTestId(testId), { key: "Escape" })
		expect(screen.queryByTestId(testId)).not.toBeInTheDocument()
		await waitFor(() => expect(button).toHaveFocus())
		expect(button).toHaveAttribute("aria-expanded", "false")
	})

	it("is a popover, not a modal: the rest of the page stays interactive", () => {
		render(
			<>
				<McpServersButton />
				<button data-testid="outside" type="button">
					outside
				</button>
			</>,
		)
		fireEvent.click(screen.getByTestId("mcp-servers-button"))
		expect(screen.getByTestId("outside")).not.toHaveAttribute("aria-hidden")
		expect(screen.getByTestId("mcp-servers")).not.toHaveAttribute("aria-modal", "true")
	})
})
