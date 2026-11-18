import { describe, expect, it } from "bun:test"
import type { ApiHandler } from "@cline/llms"
import type { Message, MessageWithMetadata } from "@cline/shared"
import { createDefaultModelSettings, RoleSettingsSchema } from "@shared/model-settings"
import { walkthroughAskPick } from "@shared/Walkthrough"
import { answerWalkthrough, buildAskMessages } from "./ask"

const conversation: Message[] = [
	{ role: "user", content: "Build the parser" },
	{ role: "assistant", content: "I will validate input first." },
	{ role: "user", content: "Also reject empty values" },
	{ role: "assistant", content: [{ type: "tool_use", id: "edit", name: "editor", input: { path: "parser.ts" } }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "edit", name: "editor", content: "Saved" }] },
	{ role: "assistant", content: "Added validation." },
]

describe("walkthrough Ask request", () => {
	it("preserves the full native conversation prefix without mutating it", () => {
		const original = structuredClone(conversation)
		const built = buildAskMessages(conversation, "thread", "parser.ts\n+if (!value) return", "Why?")
		expect(built.slice(0, conversation.length)).toEqual(original)
		expect(built.at(-1)?.content).toContain("parser.ts\n+if (!value) return")
		expect(conversation).toEqual(original)
	})
	it("sends the latest user turn with its tool pairs for recent context", () => {
		const built = buildAskMessages(conversation, "recent", "selection", "Why?")
		expect(built.slice(0, -1)).toEqual(conversation.slice(2))
		expect(JSON.stringify(built)).not.toContain("Build the parser")
	})
	it("keeps the real latest user turn when later system notices use the user role", () => {
		const withNotice: MessageWithMetadata[] = [
			...conversation,
			{ role: "user", content: "A notebook note was saved.", metadata: { userRunSpan: 0 } },
		]
		const built = buildAskMessages(withNotice, "recent", "selection", "Why?")
		expect(built[0].content).toBe("Also reject empty values")
		expect(JSON.stringify(built)).toContain("A notebook note was saved.")
	})
	it("sends only the selection and question when selected in Settings", () => {
		const built = buildAskMessages(conversation, "selection", "+guard", "Why?")
		expect(built).toHaveLength(1)
		expect(built[0].content).toContain("+guard")
		expect(JSON.stringify(built)).not.toContain("Build the parser")
	})
	it("defaults to the generation model and level, with a thread fallback and a Settings override", () => {
		const roles = createDefaultModelSettings().roles
		const thread = { modelId: "thread", levelId: "low" }
		const generated = { modelId: "generated", levelId: "high" }
		const override = { modelId: "ask", levelId: "medium" }
		expect(walkthroughAskPick(roles, undefined, thread)).toEqual(thread)
		expect(walkthroughAskPick(roles, generated, thread)).toEqual(generated)
		roles.walkthroughAsk = { context: "thread", pick: override }
		expect(walkthroughAskPick(roles, generated, thread)).toEqual(override)
		roles.walkthroughAsk.pick = null
		expect(walkthroughAskPick(roles, generated, thread)).toEqual(generated)
		expect(RoleSettingsSchema.parse(roles)).toEqual(roles)
	})
	it("passes the same system and tool prefix and makes only one request", async () => {
		let requests = 0
		const tools = [{ name: "editor", description: "Edit files", inputSchema: { type: "object" } }]
		const handler = {
			async *createMessage(system: string, messages: Message[], definitions: unknown) {
				requests++
				expect(system).toBe("Thread system")
				expect(definitions).toEqual(tools)
				expect(messages.slice(0, conversation.length)).toEqual(conversation)
				yield { type: "text", text: "Because " }
				yield { type: "text", text: "the value can be empty." }
			},
		} as unknown as ApiHandler
		expect(
			await answerWalkthrough(handler, buildAskMessages(conversation, "thread", "+guard", "Why?"), {
				systemPrompt: "Thread system",
				tools,
			}),
		).toBe("Because the value can be empty.")
		expect(requests).toBe(1)
	})
	it("rejects tool requests and empty answers without executing or retrying", async () => {
		for (const chunks of [[{ type: "tool_calls" }], [], [{ type: "done", success: false, error: "No credentials" }]]) {
			let requests = 0
			const handler = {
				async *createMessage() {
					requests++
					yield* chunks
				},
			} as unknown as ApiHandler
			await expect(answerWalkthrough(handler, [])).rejects.toThrow()
			expect(requests).toBe(1)
		}
	})
})
