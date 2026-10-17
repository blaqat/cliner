import { describe, expect, it } from "vitest"
import { buildMessageLink, parseMessageLink } from "./message-links"

describe("message links", () => {
	it("builds a vscode:// URI for the fork's extension id and round-trips through parse", () => {
		const url = buildMessageLink("saoudrizwan.cliner", "1700000000000_abc123", 14)
		expect(url).toBe("vscode://saoudrizwan.cliner/thread/1700000000000_abc123?m=14")
		expect(parseMessageLink(url)).toEqual({ threadId: "1700000000000_abc123", messageIndex: 14 })
	})

	it("accepts index 0 and any extension id authority", () => {
		expect(parseMessageLink("vscode://saoudrizwan.claude-dev/thread/t1?m=0")).toEqual({ threadId: "t1", messageIndex: 0 })
	})

	it("escapes and restores ids with reserved characters", () => {
		const url = buildMessageLink("saoudrizwan.cliner", "a b/c", 3)
		expect(url).not.toContain("a b/c")
		expect(parseMessageLink(url)).toEqual({ threadId: "a b/c", messageIndex: 3 })
	})

	it("tolerates surrounding whitespace from a paste", () => {
		expect(parseMessageLink("  vscode://saoudrizwan.cliner/thread/t1?m=2\n")).toEqual({ threadId: "t1", messageIndex: 2 })
	})

	it.each([
		"https://example.com/thread/t1?m=2",
		"vscode://saoudrizwan.cliner/openrouter?code=1",
		"vscode://saoudrizwan.cliner/thread/t1",
		"vscode://saoudrizwan.cliner/thread/t1?m=-1",
		"vscode://saoudrizwan.cliner/thread/t1?m=1.5",
		"vscode://saoudrizwan.cliner/thread/t1?m=abc",
		"vscode://saoudrizwan.cliner/thread/t1?m=",
		"vscode://saoudrizwan.cliner/thread/?m=1",
		"vscode://saoudrizwan.cliner/thread/a/b?m=1",
		"not a url",
		"",
	])("rejects %j", (input) => {
		expect(parseMessageLink(input)).toBeUndefined()
	})
})
