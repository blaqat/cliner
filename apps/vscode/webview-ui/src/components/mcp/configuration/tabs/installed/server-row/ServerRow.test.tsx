import type { McpServer } from "@shared/mcp"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ServerRow from "./ServerRow"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ autoApprovalSettings: { enabled: false }, setMcpServers: vi.fn(), remoteConfigSettings: {} }),
}))
vi.mock("@/services/grpc-client", () => ({ McpServiceClient: {} }))

function show(status: McpServer["status"], error: string) {
	const server: McpServer = { name: "test", config: "{}", status, error }
	render(<ServerRow server={server} />)
}

describe("MCP startup hook status", () => {
	it("shows a skipped connection and lets the user retry", () => {
		show("disconnected", "Skipped by McpServerStart hook")
		expect(screen.getByText("Skipped by McpServerStart hook")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Retry Connection" })).toBeEnabled()
	})
	it("shows hook failure and lets the user retry", () => {
		show("disconnected", "McpServerStart hook failed: invalid credentials")
		expect(screen.getByText("McpServerStart hook failed: invalid credentials")).toHaveClass("text-failed-icon")
		expect(screen.getByRole("button", { name: "Retry Connection" })).toBeEnabled()
	})
})
