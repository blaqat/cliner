import { describe, expect, it } from "vitest"
import {
	formatMessageReference,
	messageReferenceSource,
	parseMessageReferences,
	prependMessageReferences,
	stripMessageReferences,
} from "./message-references"

const ref = { threadId: "7_src", threadTitle: "Dev plan", author: "user" as const, text: "Cap exports" }

describe("message references", () => {
	it("names the source thread, the author and the message text", () => {
		expect(formatMessageReference(ref)).toBe(
			'<message_reference thread_id="7_src" thread_title="Dev plan" author="user">\nCap exports\n</message_reference>',
		)
	})

	it("treats any non-user author as the assistant and escapes attribute values", () => {
		const block = formatMessageReference({ ...ref, threadTitle: 'Q "&" <x>', author: "" as never })
		expect(block).toContain('author="assistant"')
		expect(block).toContain('thread_title="Q &quot;&amp;&quot; &lt;x&gt;"')
	})

	it("does not claim transcript access", () => {
		const block = formatMessageReference(ref)
		expect(block).not.toContain("thread_reference")
		expect(block).not.toContain("read_thread")
	})

	it("caps a very long message", () => {
		const block = formatMessageReference({ ...ref, text: "x".repeat(50_000) })
		expect(block.length).toBeLessThan(21_000)
		expect(block).toContain("[message truncated]")
	})

	it("puts the blocks ahead of the user's text, or leaves the text alone with none", () => {
		expect(prependMessageReferences("hello", ["<a/>", "<b/>"])).toBe("<a/>\n\n<b/>\n\nhello")
		expect(prependMessageReferences("hello", [])).toBe("hello")
		expect(prependMessageReferences("", ["<a/>"])).toBe("<a/>")
	})

	it("parses the blocks back out and leaves only the typed text", () => {
		const second = { ...ref, threadTitle: 'Q "&" <x>', author: "assistant" as const, text: "Line 1\nLine 2" }
		const sent = prependMessageReferences("use these", [formatMessageReference(ref), formatMessageReference(second)])
		expect(parseMessageReferences(sent)).toEqual({ text: "use these", references: [ref, second] })
		expect(stripMessageReferences(sent)).toBe("use these")
	})

	it("round-trips a message that contains a closing tag", () => {
		const tricky = { ...ref, text: "before </message_reference> after" }
		const sent = prependMessageReferences("go", [formatMessageReference(tricky)])
		expect(parseMessageReferences(sent)).toEqual({ text: "go", references: [tricky] })
	})

	it("returns text without blocks unchanged, including an unterminated opening tag", () => {
		expect(parseMessageReferences("plain")).toEqual({ text: "plain", references: [] })
		const broken = '<message_reference thread_id="a" author="user">never closed'
		expect(parseMessageReferences(broken)).toEqual({ text: broken, references: [] })
	})

	it("keeps where the message is, so the sent chip can open it scrolled to the message", () => {
		const block = formatMessageReference({ ...ref, messageIndex: 4, toolCallId: "call_1", block: 2 })
		// A tool call id wins over the block ordinal, as in links.
		expect(block).toContain('message_index="4" tool_call_id="call_1">')
		expect(block).not.toContain("block=")
		expect(parseMessageReferences(`${block}\n\nhi`).references).toEqual([{ ...ref, messageIndex: 4, toolCallId: "call_1" }])
		const byBlock = formatMessageReference({ ...ref, messageIndex: 0, block: 1 })
		expect(parseMessageReferences(byBlock).references).toEqual([{ ...ref, messageIndex: 0, block: 1 }])
	})

	it("leaves the position out when it isn't known, and ignores a malformed one", () => {
		expect(formatMessageReference({ ...ref, messageIndex: -1 })).not.toContain("message_index")
		const malformed =
			'<message_reference thread_id="7_src" thread_title="Dev plan" author="user" message_index="x" block="1">\nCap exports\n</message_reference>'
		expect(parseMessageReferences(malformed).references).toEqual([ref])
	})

	it("labels chips like the composer does", () => {
		expect(messageReferenceSource(ref)).toBe("You · Dev plan")
		expect(messageReferenceSource({ author: "assistant", threadTitle: "" })).toBe("Cline")
	})
})
