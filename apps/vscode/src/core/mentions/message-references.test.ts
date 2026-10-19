import { describe, expect, it } from "vitest"
import { formatMessageReference, prependMessageReferences } from "./message-references"

describe("message references", () => {
	it("names the source thread, the author and the message text", () => {
		expect(formatMessageReference({ threadId: "7_src", threadTitle: "Dev plan", author: "user", text: "Cap exports" })).toBe(
			'<message_reference thread_id="7_src" thread_title="Dev plan" author="user">\nCap exports\n</message_reference>',
		)
	})

	it("treats any non-user author as the assistant and escapes attribute values", () => {
		const block = formatMessageReference({ threadId: "a", threadTitle: 'Q "&" <x>', author: "", text: "t" })
		expect(block).toContain('author="assistant"')
		expect(block).toContain('thread_title="Q &quot;&amp;&quot; &lt;x&gt;"')
	})

	it("does not claim transcript access", () => {
		const block = formatMessageReference({ threadId: "a", threadTitle: "T", author: "user", text: "t" })
		expect(block).not.toContain("thread_reference")
		expect(block).not.toContain("read_thread")
	})

	it("caps a very long message", () => {
		const block = formatMessageReference({ threadId: "a", threadTitle: "T", author: "user", text: "x".repeat(50_000) })
		expect(block.length).toBeLessThan(21_000)
		expect(block).toContain("[message truncated]")
	})

	it("puts the blocks ahead of the user's text, or leaves the text alone with none", () => {
		expect(prependMessageReferences("hello", ["<a/>", "<b/>"])).toBe("<a/>\n\n<b/>\n\nhello")
		expect(prependMessageReferences("hello", [])).toBe("hello")
		expect(prependMessageReferences("", ["<a/>"])).toBe("<a/>")
	})
})
