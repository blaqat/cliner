import type { AgentToolContext } from "@cline/shared"
import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it, vi } from "vitest"
import { createSideThreadTools, formatMainThread, resolveMainThread, type SideThreadContext } from "./side-thread-tools"

const call: AgentToolContext = { sessionId: "side", agentId: "side-agent", iteration: 1 }
function fixture() {
	const context: SideThreadContext = {
		sessionId: "side",
		mainThreadId: "main",
		readMessages: vi.fn(async () => [{ role: "user" as const, content: "New question" }]),
		sendNote: vi.fn(async () => {}),
		consumeNotes: vi.fn(async () => undefined),
	}
	return { context, tools: createSideThreadTools(context) }
}

describe("side thread tools", () => {
	it("registers both tools only for an aside, without subagent inheritance", () => {
		expect(createSideThreadTools()).toEqual([])
		const { context, tools } = fixture()
		expect(createSideThreadTools({ ...context, mainThreadId: undefined })).toEqual([])
		expect(tools.map((tool) => tool.name)).toEqual(["read_main_thread", "send_to_main_thread"])
		expect(tools.every((tool) => tool.metadata?.subagentAccess === undefined)).toBe(true)
	})
	it("refuses main-thread and subagent calls even if a tool reference leaks", async () => {
		const { context, tools } = fixture()
		for (const sessionId of ["main", "side__child", undefined]) {
			for (const tool of tools)
				expect(await tool.execute({ message: "hello" }, { ...call, sessionId })).toHaveProperty("error")
		}
		expect(context.sendNote).not.toHaveBeenCalled()
		expect(context.readMessages).not.toHaveBeenCalled()
	})
	it("reads fresh messages on each call and validates bounds", async () => {
		const { context, tools } = fixture()
		expect(await tools[0].execute({}, call)).toBe("user: New question")
		vi.mocked(context.readMessages).mockResolvedValueOnce([{ role: "assistant", content: "Latest answer" }])
		expect(await tools[0].execute({}, call)).toBe("assistant: Latest answer")
		expect(await tools[0].execute({ max_messages: 0 }, call)).toHaveProperty("error")
		expect(await tools[0].execute({ max_chars: 40001 }, call)).toHaveProperty("error")
	})
	it("sends only a bounded note to its fixed main thread", async () => {
		const { context, tools } = fixture()
		expect(await tools[1].execute({ message: " useful context " }, call)).toEqual({ queued: true })
		expect(context.sendNote).toHaveBeenCalledWith("main", "side", "useful context")
		for (const message of ["", " ", "x".repeat(4001)])
			expect(await tools[1].execute({ message }, call)).toHaveProperty("error")
		expect(context.sendNote).toHaveBeenCalledTimes(1)
	})
	it("returns structured errors when the main thread is unavailable", async () => {
		const { context, tools } = fixture()
		vi.mocked(context.readMessages).mockRejectedValue(new Error("deleted"))
		vi.mocked(context.sendNote).mockRejectedValue(new Error("deleted"))
		expect(await tools[0].execute({}, call)).toHaveProperty("error")
		expect(await tools[1].execute({ message: "hello" }, call)).toHaveProperty("error")
	})
})

it("formats recent conversation in order with tool summaries, skipping noise and capping characters", () => {
	const text = formatMainThread(
		[
			{ role: "user", content: "old" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "Answer" },
					{ type: "tool_use", id: "t", name: "read_files", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", name: "read_files", content: "huge output" }] },
			{ role: "user", content: "hook noise", metadata: { displayRole: "system" } },
			{ role: "user", content: "latest" },
		],
		3,
	)
	expect(text).toBe("assistant: Answer\n[tool: read_files]\n\nuser: [tool result: read_files]\n\nuser: latest")
	expect(formatMainThread([{ role: "assistant", content: "x".repeat(1000) + "END" }], 30, 100)).toHaveLength(100)
	expect(formatMainThread([{ role: "assistant", content: "x".repeat(1000) + "END" }], 30, 100)).toMatch(/END$/)
})

it("resolves nested asides to Main, rejecting main, helpers, missing parents and cycles", async () => {
	const root = { id: "main" } as HistoryItem
	const side = { id: "side", parentTaskId: "main" } as HistoryItem
	const find = async (id: string) => [root, side].find((item) => item.id === id)
	await expect(resolveMainThread({ id: "nested", parentTaskId: "side" }, find)).resolves.toBe("main")
	for (const item of [
		root,
		{ ...side, isSubagent: true },
		{ ...side, runtimeOwnerTaskId: "main" },
		{ ...side, parentTaskId: "missing" },
		{ ...side, parentTaskId: "side" },
	]) {
		await expect(resolveMainThread(item, find)).resolves.toBeUndefined()
	}
})
