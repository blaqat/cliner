import { describe, expect, it } from "vitest"
import { sdkMessagesToClineMessages } from "./message-translator"
import { buildAsideConversation } from "./sdk-aside-conversation"
import type { SdkInitialMessages } from "./session-host"

const transcript: SdkInitialMessages = [
	{ role: "user", content: "Question" },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "First answer" },
			{ type: "text", text: "Later answer" },
		],
	},
	{ role: "user", content: "Follow up" },
]

describe("aside conversation", () => {
	it("includes the selected message and excludes later blocks and turns", () => {
		const visible = sdkMessagesToClineMessages(transcript)
		const selected = visible.find((message) => message.text === "First answer")!
		const fork = buildAsideConversation(transcript, visible, selected.ts)
		expect(fork).toEqual([transcript[0], { role: "assistant", content: [{ type: "text", text: "First answer" }] }])
		expect(transcript).toHaveLength(3)
		expect(transcript[1].content).toHaveLength(2)
	})

	it("maps a live row's identity to its SDK source message", () => {
		const visible = sdkMessagesToClineMessages(transcript).map(({ sdkMessageIndex: _index, ...message }) => message)
		const selected = visible.find((message) => message.text === "First answer")!
		expect(buildAsideConversation(transcript, visible, selected.ts)).toHaveLength(2)
	})

	it("rejects an unknown timestamp", () => {
		expect(() => buildAsideConversation(transcript, sdkMessagesToClineMessages(transcript), 999)).toThrow("not found")
	})

	it("preserves OpenAI Responses reasoning items and tool item ids in the copy", () => {
		const reasoningItems = [{ itemId: "rs_1", text: "", reasoningEncryptedContent: "opaque" }]
		const source: SdkInitialMessages = [
			{ role: "user", content: "Question" },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "",
						// The Responses bridge persists object-form details; the declared
						// `unknown[]` shape predates it.
						details: { openaiReasoningItems: reasoningItems } as unknown as unknown[],
					},
					{ type: "tool_use", id: "call_1", name: "read_files", input: {}, openaiItemId: "fc_1" },
					{ type: "text", text: "Done" },
				],
			},
		]
		const visible = sdkMessagesToClineMessages(source)
		const fork = buildAsideConversation(source, visible, visible.at(-1)!.ts)
		// Selecting the tool row cuts after it; the thinking and tool_use blocks
		// must keep their provider continuation fields verbatim.
		expect(fork[1]?.content).toEqual((source[1]!.content as unknown[]).slice(0, 2))
	})
})

it("copies a streaming answer even before the SDK commits it", () => {
	const raw: SdkInitialMessages = [{ role: "user", content: "Question" }]
	const visible = [
		{ ts: 1, type: "say" as const, say: "task" as const, text: "Question" },
		{ ts: 2, type: "say" as const, say: "text" as const, text: "Partial answer", partial: true },
	]
	expect(buildAsideConversation(raw, visible, 2)).toEqual([raw[0], { role: "assistant", content: "Partial answer" }])
})
