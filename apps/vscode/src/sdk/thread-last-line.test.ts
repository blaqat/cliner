import type { ClineMessage } from "@shared/ExtensionMessage"
import { TaskItem, TaskResponse } from "@shared/proto/cline/task"
import { describe, expect, it } from "vitest"
import { makeLastLine } from "./sdk-task-history"
import { messageLastLine } from "./thread-last-line"

const message = (extra: Partial<ClineMessage>): ClineMessage => ({
	ts: 1,
	type: "say",
	say: "text",
	text: " Hello\n world ",
	...extra,
})

describe("thread previews", () => {
	it("uses complete agent text, completion and followup questions", () => {
		expect(messageLastLine(message({}))).toEqual({ author: "agent", text: "Hello world" })
		expect(messageLastLine(message({ say: "completion_result" }))?.author).toBe("agent")
		expect(messageLastLine(message({ type: "ask", ask: "followup", text: '{"question":"Which file?"}' }))).toEqual({
			author: "agent",
			text: "Which file?",
		})
	})
	it("ignores partials, reasoning and tool output", () => {
		for (const extra of [
			{ partial: true },
			{ say: "reasoning" },
			{ say: "tool" },
			{ say: "command_output" },
		] as Partial<ClineMessage>[])
			expect(messageLastLine(message(extra))).toBeUndefined()
	})
	it("describes approval requests without their full payload", () => {
		expect(messageLastLine(message({ type: "ask", ask: "command", text: "bun test" }))).toEqual({
			author: "ask",
			text: "approve command: bun test",
		})
		for (const [tool, text] of [
			["readFile", "approve reading foo.ts"],
			["editedExistingFile", "approve edit to foo.ts"],
		])
			expect(
				messageLastLine(
					message({ type: "ask", ask: "tool", text: JSON.stringify({ tool, path: "foo.ts", content: "secret code" }) }),
				),
			).toEqual({ author: "ask", text })
	})
	it("bounds and normalizes user text and round trips both RPC mirrors", () => {
		const lastLine = makeLastLine("user", "  hello\n" + "x".repeat(200))
		expect(lastLine.text).toHaveLength(160)
		expect(lastLine.text.startsWith("hello x")).toBe(true)
		for (const type of [TaskItem, TaskResponse]) {
			const item = type.create({ id: "a", isStashed: true, stashedAt: 123, lastLine })
			expect(type.decode(type.encode(item).finish())).toMatchObject({ isStashed: true, stashedAt: 123, lastLine })
		}
	})
})
