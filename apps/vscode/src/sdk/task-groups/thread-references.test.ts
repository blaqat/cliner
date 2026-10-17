import type { AgentToolContext } from "@cline/shared"
import { describe, expect, it } from "vitest"
import { expandTaskNoteMentions } from "@/core/mentions/task-notes"
import { expandThreadMentions, extractThreadMentionIds } from "@/core/mentions/thread-mentions"
import {
	clineMessagesToTranscript,
	grepTranscript,
	sdkMessagesToTranscript,
	sliceTranscript,
	TRANSCRIPT_READ_MAX_MESSAGES,
	type TranscriptEntry,
} from "./thread-transcript"
import { createThreadTranscriptTools } from "./thread-transcript-tool"

const entries = (rows: [string, string][]): TranscriptEntry[] =>
	rows.map(([role, text], index) => ({ index, ts: index, role, text }))

const REPRO: TranscriptEntry[] = entries([
	["user", "The login loop is back."],
	["assistant", "Checking.\nThe callback uses http:// behind the LB"],
	["user", "ok"],
	["assistant", "redirect_uri mismatch -> loop\nfixed by trusting X-Forwarded-Proto"],
])

describe("thread: mentions", () => {
	const threads: Record<string, string> = { "1_abc": "Repro on staging", "2_def": 'Say "hi"' }
	const resolve = async (id: string) => (threads[id] ? { id, title: threads[id] } : undefined)

	it("expands to id + title only and reports the allowed ids", async () => {
		const result = await expandThreadMentions("What did thread:1_abc find? Also thread:nope.", resolve)
		expect(result.threadIds).toEqual(["1_abc"])
		expect(result.text).toContain('<thread_reference id="1_abc" title="Repro on staging">')
		expect(result.text).toContain("thread:nope.")
		expect(result.text).not.toContain("login loop")
	})

	it("escapes titles and dedupes repeated mentions", async () => {
		const result = await expandThreadMentions("thread:2_def and thread:2_def", resolve)
		expect(result.threadIds).toEqual(["2_def"])
		expect(result.text).toContain('title="Say &quot;hi&quot;"')
	})

	it("ignores thread: inside links and paths", async () => {
		const text = "see vscode://x/thread/1_abc?m=1 and a/thread:1_abc and me@thread:1_abc"
		const result = await expandThreadMentions(text, resolve)
		expect(result.threadIds).toEqual([])
		expect(result.text).toBe(text)
	})
})

describe("thread: authorization comes from the user's original input", () => {
	const resolve = async (id: string) => ({ id, title: `Title ${id}` })

	it("does not authorize or expand thread: mentions that came from an expanded note", async () => {
		const original = "Use #sso-loop please. Also check thread:1_typed"
		const typed = new Set(extractThreadMentionIds(original))
		const expandedNotes = await expandTaskNoteMentions(original, async () => ({
			name: "SSO",
			content: "see thread:9_secret for details",
		}))
		const result = await expandThreadMentions(expandedNotes, resolve, typed)
		expect(result.threadIds).toEqual(["1_typed"])
		expect(result.text).toContain("thread:9_secret")
		expect(result.text).not.toContain('id="9_secret"')
	})

	it("authorizes nothing when the user typed no thread mention", async () => {
		const typed = new Set(extractThreadMentionIds("just #note"))
		const result = await expandThreadMentions("<file>thread:9_secret</file>", resolve, typed)
		expect(result.threadIds).toEqual([])
		expect(result.text).toBe("<file>thread:9_secret</file>")
	})
})

describe("cross-task #note mentions", () => {
	it("passes the group qualifier to the reader and tags the note's task", async () => {
		const seen: [string, string | undefined][] = []
		const text = await expandTaskNoteMentions("Use #sso-loop/timezone and #local", async (slug, qualifier) => {
			seen.push([slug, qualifier])
			return qualifier ? { name: "Timezone", content: "UTC", taskTitle: 'SSO "loop"' } : { name: "Local", content: "mine" }
		})
		expect(seen).toEqual([
			["timezone", "sso-loop"],
			["local", undefined],
		])
		expect(text).toBe(
			'Use <task_note name="Timezone" task="SSO &quot;loop&quot;">\nUTC\n</task_note> and <task_note name="Local">\nmine\n</task_note>',
		)
	})

	it("leaves unresolved qualified mentions untouched", async () => {
		expect(await expandTaskNoteMentions("see #gone/x", async () => undefined)).toBe("see #gone/x")
	})
})

describe("transcript grep and range reads", () => {
	it("numbers only user/assistant messages from SDK transcripts", () => {
		const transcript = sdkMessagesToTranscript([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "tool_use" }, { type: "text", text: "hello" }] },
			{ role: "user", content: [{ type: "tool_result" }] },
			{ role: "assistant", content: "bye" },
		] as never)
		expect(transcript.map((entry) => [entry.index, entry.role, entry.text])).toEqual([
			[0, "user", "hi"],
			[1, "assistant", "hello"],
			[2, "assistant", "bye"],
		])
	})

	it("builds a transcript from legacy ui messages", () => {
		const transcript = clineMessagesToTranscript([
			{ type: "say", say: "task", text: "do it" },
			{ type: "say", say: "api_req_started", text: "{}" },
			{ type: "say", say: "text", text: "done" },
		])
		expect(transcript.map((entry) => entry.role)).toEqual(["user", "assistant"])
	})

	it("greps line by line, case-insensitively, reporting the message number", () => {
		const hits = grepTranscript(REPRO, /callback|REDIRECT_URI/i)
		expect(hits).toEqual([
			{ index: 1, role: "assistant", line: "The callback uses http:// behind the LB" },
			{ index: 3, role: "assistant", line: "redirect_uri mismatch -> loop" },
		])
		expect(grepTranscript(REPRO, /loop/i, 1)).toHaveLength(1)
	})

	it("slices an inclusive range and clamps to the transcript", () => {
		expect(sliceTranscript(REPRO, 1, 2).entries.map((entry) => entry.index)).toEqual([1, 2])
		expect(sliceTranscript(REPRO, 2, 99).entries.map((entry) => entry.index)).toEqual([2, 3])
		expect(sliceTranscript(REPRO, 9, 12).entries).toEqual([])
	})

	it("truncates oversized reads", () => {
		const long = entries(Array.from({ length: TRANSCRIPT_READ_MAX_MESSAGES + 5 }, () => ["user", "x"]))
		const result = sliceTranscript(long, 0, long.length)
		expect(result.truncated).toBe(true)
		expect(result.entries.length).toBeLessThanOrEqual(TRANSCRIPT_READ_MAX_MESSAGES)
	})
})

describe("grep_threads / read_thread tools", () => {
	const transcripts: Record<string, TranscriptEntry[]> = {
		allowed: REPRO,
		secret: entries([["user", "api key is hunter2"]]),
	}
	// Allow-lists are per owner (user-facing) thread; "other" mentioned nothing.
	const allow: Record<string, string[]> = { owner: ["allowed"], other: [] }
	const titles: Record<string, string> = { allowed: "Repro on staging", secret: "Secrets" }
	const toolContext = (sessionId: string) => ({ sessionId }) as AgentToolContext

	const makeTools = async () => {
		const tools = await createThreadTranscriptTools({
			resolveOwnerThreadId: async (context) => context.sessionId as string,
			isThreadAllowed: async (owner, id) => allow[owner]?.includes(id) ?? false,
			listAllowedThreads: async (owner) => (allow[owner] ?? []).map((id) => ({ id, title: titles[id] })),
			readTranscript: async (id) => transcripts[id] ?? [],
		})
		return {
			grep: tools.find((tool) => tool.name === "grep_threads")!,
			read: tools.find((tool) => tool.name === "read_thread")!,
		}
	}

	it("is read-only and auto-available to read subagents", async () => {
		const { grep, read } = await makeTools()
		expect(grep.metadata?.subagentAccess).toBe("read")
		expect(read.metadata?.subagentAccess).toBe("read")
	})

	it("greps all mentioned threads when no thread_id is given", async () => {
		const { grep } = await makeTools()
		const out = await grep.execute({ pattern: "callback|redirect_uri" }, toolContext("owner"))
		expect(out).toContain("2 hit(s) in 1 thread(s)")
		expect(out).toContain("Repro on staging #1  The callback uses http:// behind the LB")
		expect(out).toContain("Repro on staging #3  redirect_uri mismatch -> loop")
		expect(out).not.toContain("hunter2")
	})

	it("refuses a thread id the user did not mention, naming what is allowed", async () => {
		const { grep, read } = await makeTools()
		for (const result of [
			await grep.execute({ pattern: "key", thread_id: "secret" }, toolContext("owner")),
			await read.execute({ thread_id: "secret" }, toolContext("owner")),
		]) {
			expect(result).toMatchObject({ error: expect.stringContaining('Thread "secret" was not mentioned') })
			expect((result as { error: string }).error).toContain('"Repro on staging" (allowed)')
			expect(JSON.stringify(result)).not.toContain("hunter2")
		}
	})

	it("scopes the allow-list per conversation", async () => {
		const { grep, read } = await makeTools()
		expect(await read.execute({ thread_id: "allowed" }, toolContext("other"))).toMatchObject({
			error: expect.stringContaining("was not mentioned"),
		})
		expect(await grep.execute({ pattern: "callback" }, toolContext("other"))).toMatchObject({
			error: expect.stringContaining("No threads were mentioned"),
		})
	})

	it("reads an inclusive line range matching grep's #numbers", async () => {
		const { read } = await makeTools()
		const out = (await read.execute({ thread_id: "allowed", start: 1, end: 2 }, toolContext("owner"))) as string
		expect(out).toContain("messages 1–2 of 3")
		expect(out).toContain("#1 assistant: Checking.")
		expect(out).toContain("#2 user: ok")
		expect(out).not.toContain("#0")
		expect(out).not.toContain("#3")
	})

	it("reports bad ranges and bad patterns as errors", async () => {
		const { grep, read } = await makeTools()
		expect(await read.execute({ thread_id: "allowed", start: 3, end: 1 }, toolContext("owner"))).toMatchObject({
			error: expect.stringContaining("after end"),
		})
		expect(await read.execute({ thread_id: "allowed", start: 50, end: 60 }, toolContext("owner"))).toMatchObject({
			error: expect.stringContaining("No messages in range"),
		})
		expect(await grep.execute({ pattern: "(" }, toolContext("owner"))).toMatchObject({
			error: expect.stringContaining("Invalid regex"),
		})
	})
})
