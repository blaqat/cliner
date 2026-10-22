import sinon from "sinon"
import { describe, expect, it } from "vitest"
import { createVscodeExtraTools, McpHubToolProvider } from "./vscode-runtime-builder"

describe("McpHubToolProvider", () => {
	it("forwards the agent abort signal to McpHub", async () => {
		const callTool = sinon.stub().resolves({ content: [] })
		const provider = new McpHubToolProvider({ callTool } as never)
		const controller = new AbortController()

		await provider.callTool({
			serverName: "server",
			toolName: "slow-tool",
			context: {
				agentId: "agent",
				iteration: 1,
				signal: controller.signal,
			},
		})

		expect(callTool.calledOnce).toBe(true)
		expect(callTool.firstCall.args[4]).toBe(controller.signal)
	})
})

it("registers present_walkthrough without requiring MCP or exposing it to subagents", async () => {
	const tools = await createVscodeExtraTools({ getServers: () => [] } as never)
	const tool = tools.find((tool) => tool.name === "present_walkthrough")
	expect(tool).toBeDefined()
	expect(tool?.metadata?.subagentAccess).toBeUndefined()
	expect(tool?.inputSchema).toMatchObject({ required: ["title", "chapters"] })
})
