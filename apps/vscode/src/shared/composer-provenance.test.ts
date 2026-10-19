import { describe, expect, it } from "vitest"
import { authorizedThreadIds, messageLinkRefs, normalizeProvenance } from "./composer-provenance"

describe("message links in composer provenance", () => {
	it("keeps valid links and drops protobuf defaults, bad ids and duplicates", () => {
		const links = messageLinkRefs({
			messageLinks: [
				{ threadId: "t1", messageIndex: 3, toolCallId: "call_1", block: 0 },
				{ threadId: "t1", messageIndex: 3, toolCallId: "call_1" },
				{ threadId: "t2", messageIndex: 0, toolCallId: "", block: 2 },
				{ threadId: "", messageIndex: 1 },
				{ threadId: "t3", messageIndex: -1 },
			],
		})
		// A tool call id wins over the block ordinal; empty strings are protobuf defaults.
		expect(links).toEqual([
			{ threadId: "t1", messageIndex: 3, toolCallId: "call_1" },
			{ threadId: "t2", messageIndex: 0, block: 2 },
		])
	})

	it("keeps a verbatim reference (edit-and-resend) with its text and attribution", () => {
		const links = messageLinkRefs({
			messageLinks: [
				{ threadId: "t1", messageIndex: 0, threadTitle: "Dev plan", author: "user", text: "Cap exports" },
				{ threadId: "t1", messageIndex: 0, threadTitle: "Dev plan", author: "user", text: "Cap exports" },
				{ threadId: "t1", messageIndex: 0, text: "Another" },
			],
		})
		expect(links).toEqual([
			{ threadId: "t1", messageIndex: 0, text: "Cap exports", threadTitle: "Dev plan", author: "user" },
			{ threadId: "t1", messageIndex: 0, text: "Another", threadTitle: "", author: "assistant" },
		])
	})

	it("keeps a message-link-only provenance without authorizing any thread", () => {
		const normalized = normalizeProvenance({ authorizedThreadIds: [], messageLinks: [{ threadId: "t1", messageIndex: 1 }] })
		expect(normalized?.messageLinks).toEqual([{ threadId: "t1", messageIndex: 1 }])
		expect([...authorizedThreadIds(normalized)]).toEqual([])
	})

	it("is still empty when there is nothing explicit", () => {
		expect(normalizeProvenance({ authorizedThreadIds: [], messageLinks: [] })).toBeUndefined()
	})
})
