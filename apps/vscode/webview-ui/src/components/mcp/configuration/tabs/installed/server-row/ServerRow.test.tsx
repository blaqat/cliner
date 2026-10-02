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
	it("shows a running hook without a retry button or failure styling", () => {
		show("connecting", "Running start hook…")
		expect(screen.getByText("Running start hook…")).toHaveClass("text-description")
		expect(screen.queryByRole("button", { name: "Retrying..." })).not.toBeInTheDocument()
	})
	it("shows hook failure and lets the user retry", () => {
		show("disconnected", "Start hook failed: invalid credentials")
		expect(screen.getByText("Start hook failed: invalid credentials")).toHaveClass("text-failed-icon")
		expect(screen.getByRole("button", { name: "Retry Connection" })).toBeEnabled()
	})
})
