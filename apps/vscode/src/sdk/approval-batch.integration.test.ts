import { AgentRuntime } from "@cline/agents"
import type { AgentModel, AgentModelRequest, AgentTool } from "@cline/shared"
import { describe, expect, it, vi } from "vitest"
import { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { createTaskProxy } from "./task-proxy"

// Real approval coordinator and SDK loop: one model message, two tools, one pending ask.
describe("approval batch recovery", () => {
	it.each(["skip", "reject", "auto-approve toggle", "cancel"])("settles both tool calls after %s", async (action) => {
		const task = createTaskProxy("batch-test", vi.fn(), vi.fn())
		let autoApproveCommands = false
		const interactions = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => task.taskId,
			postStateToWebview: async () => {},
			shouldAutoApproveTool: () => autoApproveCommands,
		})
		const read = vi.fn(async () => "app.js contents")
		const command = vi.fn(async () => "command output")
		let requests = 0
		const model: AgentModel = {
			async *stream(request: AgentModelRequest) {
				if (requests++ === 0) {
					for (const name of ["read_files", "run_commands"]) {
						yield { type: "tool-call-delta" as const, toolCallId: name, toolName: name, inputText: "{}" }
					}
					yield { type: "finish" as const, reason: "tool-calls" }
				} else {
					expect(request.messages.filter((message) => message.role === "tool")).toHaveLength(2)
					yield { type: "text-delta" as const, text: "continued" }
					yield { type: "finish" as const, reason: "stop" }
				}
			},
		}
		const tools: AgentTool[] = [
			{
				name: "read_files",
				description: "read",
				inputSchema: { type: "object" },
				executionMode: "parallel",
				execute: read,
			},
			{
				name: "run_commands",
				description: "command",
				inputSchema: { type: "object" },
				executionMode: "parallel",
				execute: command,
			},
		]
		const runtime = new AgentRuntime({
			model,
			tools,
			toolPolicies: { read_files: { autoApprove: true }, run_commands: { autoApprove: false } },
			requestToolApproval: (request) => interactions.handleRequestToolApproval(request),
		})
		const run = runtime.run("change app.js")
		await vi.waitFor(() => expect(interactions.getPendingDecision()?.kind).toBe("approval"))
		const decisionId = interactions.getPendingDecision()!.id
		if (action === "auto-approve toggle") {
			autoApproveCommands = true
			// Settings changes apply to future requests. The visible decision keeps its resolver.
			expect(interactions.getPendingDecision()?.id).toBe(decisionId)
		}
		if (action === "cancel") {
			interactions.clearPending("Task cancelled")
			runtime.abort("Task cancelled")
		} else {
			expect(
				interactions.resolvePendingToolApproval(
					action === "skip" ? "The user skipped this command" : undefined,
					action === "auto-approve toggle" ? "yesButtonClicked" : "noButtonClicked",
					undefined,
					undefined,
					decisionId,
				),
			).toBe(true)
		}
		const result = await run
		expect(result.status).toBe(action === "cancel" ? "aborted" : "completed")
		const results = result.messages.flatMap((message) => message.content).filter((part) => part.type === "tool-result")
		expect(results.map((part) => part.toolCallId)).toEqual(["read_files", "run_commands"])
		expect(interactions.hasPendingUserDecision()).toBe(false)
		if (action !== "cancel") expect(read).toHaveBeenCalledOnce()
		expect(command).toHaveBeenCalledTimes(action === "auto-approve toggle" ? 1 : 0)
		if (action === "reject" || action === "skip") expect(results[1].isError).toBe(true)
	})
})
