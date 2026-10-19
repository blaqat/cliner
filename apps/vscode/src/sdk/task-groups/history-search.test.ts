import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HistorySearchThread } from "@shared/task-groups"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HistorySearcher } from "./history-search"
import { NotebookStore } from "./notebook-store"
import { TaskGroupStore } from "./task-group-store"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

type MessagePart = { type: string; text?: string; [key: string]: unknown }
type Message = { id: string; role: string; content: string | MessagePart[]; ts?: number; [key: string]: unknown }

function textMessage(role: "user" | "assistant", text: string, ts: number): Message {
	return { id: `${role}-${ts}`, role, content: [{ type: "text", text }], ts }
}

async function writeSession(
	sessionsDir: string,
	sessionId: string,
	messages: Message[],
	options?: { manifest?: Record<string, unknown>; mtimeMs?: number },
): Promise<string> {
	const dir = path.join(sessionsDir, sessionId)
	await fs.mkdir(dir, { recursive: true })
	const filePath = path.join(dir, `${sessionId}.messages.json`)
	await fs.writeFile(filePath, JSON.stringify({ version: 1, sessionId, messages }), "utf8")
	if (options?.manifest) {
		await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(options.manifest), "utf8")
	}
	if (options?.mtimeMs !== undefined) {
		const mtime = new Date(options.mtimeMs)
		await fs.utimes(filePath, mtime, mtime)
	}
	return filePath
}

/** Writes `<taskGroupsDir>/<groupId>/notebook/<slug>.md` with fixed frontmatter. */
async function writeNote(
	taskGroupsDir: string,
	groupId: string,
	slug: string,
	note: { name: string; description: string; body: string; updated: string },
): Promise<void> {
	const dir = path.join(taskGroupsDir, groupId, "notebook")
	await fs.mkdir(dir, { recursive: true })
	const filePath = path.join(dir, `${slug}.md`)
	await fs.writeFile(
		filePath,
		`---\nname: ${note.name}\ndescription: ${note.description}\nupdated: ${note.updated}\n---\n\n${note.body}\n`,
		"utf8",
	)
	// readNoteMeta trusts frontmatter `updated` only when the file mtime isn't
	// newer (hand edits bump mtime) — pin the mtime to the same instant.
	const mtime = new Date(note.updated)
	await fs.utimes(filePath, mtime, mtime)
}

describe("HistorySearcher", () => {
	let rootDir: string
	let sessionsDir: string
	let taskGroupsDir: string
	let searcher: HistorySearcher

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-history-search-"))
		sessionsDir = path.join(rootDir, "sessions")
		taskGroupsDir = path.join(rootDir, "task-groups")
		await fs.mkdir(sessionsDir, { recursive: true })
		searcher = new HistorySearcher({ sessionsDir, taskGroupsDir })
	})

	afterEach(async () => {
		await fs.rm(rootDir, { recursive: true, force: true })
	})

	describe("messages", () => {
		it("matches user and assistant text, case-insensitive, with thread context", async () => {
			const threads: HistorySearchThread[] = [{ id: "s1", title: "Deploy API", ts: 100, taskGroupId: "g1" }]
			await writeSession(sessionsDir, "s1", [
				textMessage("user", "can you deploy the api tonight?", 100),
				textMessage("assistant", "Sure, deploying now.", 101),
				{
					id: "t",
					role: "assistant",
					content: [{ type: "tool_use", name: "run_commands", input: { cmd: "deploy" } }],
					ts: 102,
				},
				{ id: "sys", role: "system", content: [{ type: "text", text: "deploy system noise" }], ts: 103 },
			])

			const hits = await searcher.search({ query: "DEPLOY", kind: "messages", threads })
			expect(hits).toHaveLength(2)
			expect(hits.map((h) => h.id).sort()).toEqual(["s1:0", "s1:1"])
			for (const hit of hits) {
				expect(hit.kind).toBe("message")
				expect(hit.threadId).toBe("s1")
				expect(hit.taskGroupId).toBe("g1")
				expect(hit.title).toBe("Deploy API")
				expect(hit.snippet.toLowerCase()).toContain("deploy")
			}
		})

		it("never shows a message_reference block in a hit snippet", async () => {
			const threads: HistorySearchThread[] = [{ id: "s1", title: "Deploy API", ts: 100 }]
			const block =
				'<message_reference thread_id="7_src" thread_title="Dev plan" author="user">\nCap exports at 10k rows\n</message_reference>'
			await writeSession(sessionsDir, "s1", [
				textMessage("user", `<user_input mode="act">${block}\n\nship the release</user_input>`, 100),
			])
			const hits = await searcher.search({ query: "ship", kind: "messages", threads })
			expect(hits.map((hit) => hit.snippet)).toEqual(["ship the release"])
			// The attached message is context, not the user's words, so its text isn't searchable.
			expect(await searcher.search({ query: "10k rows", kind: "messages", threads })).toEqual([])
		})

		it("returns newest sessions first and stops scanning at the limit", async () => {
			// Oldest session carries the largest message ts: if the scan didn't stop
			// early, its hit would sort first and appear in the results.
			await writeSession(sessionsDir, "s1", [textMessage("user", "needle", 999)], { mtimeMs: 1000 })
			await writeSession(sessionsDir, "s2", [textMessage("user", "needle", 200)], { mtimeMs: 2000 })
			await writeSession(sessionsDir, "s3", [textMessage("user", "needle", 300)], { mtimeMs: 3000 })

			const hits = await searcher.search({ query: "needle", kind: "messages", limit: 2 })
			expect(hits.map((h) => h.threadId).sort()).toEqual(["s2", "s3"])
		})

		it("prefers the newest messages within a session when truncating", async () => {
			await writeSession(sessionsDir, "s1", [
				textMessage("user", "needle one", 100),
				textMessage("assistant", "needle two", 200),
				textMessage("assistant", "needle three", 300),
			])
			const hits = await searcher.search({ query: "needle", kind: "messages", limit: 1 })
			expect(hits).toHaveLength(1)
			expect(hits[0].id).toBe("s1:2")
			expect(hits[0].snippet).toContain("three")
		})

		it("indexes message ids by raw array position, skipping non-text parts", async () => {
			await writeSession(sessionsDir, "s1", [
				textMessage("user", "hi", 100),
				{ id: "t", role: "assistant", content: [{ type: "tool_use", name: "x", input: {} }], ts: 101 },
				textMessage("assistant", "the needle", 102),
			])
			const hits = await searcher.search({ query: "needle", kind: "messages" })
			expect(hits.map((h) => h.id)).toEqual(["s1:2"])
		})

		it("builds a ~120-char snippet around the match", async () => {
			const pad = "x".repeat(200)
			await writeSession(sessionsDir, "s1", [textMessage("assistant", `${pad} needle ${pad}`, 100)])
			const hits = await searcher.search({ query: "needle", kind: "messages" })
			expect(hits).toHaveLength(1)
			expect(hits[0].snippet).toContain("needle")
			expect(hits[0].snippet.startsWith("…")).toBe(true)
			expect(hits[0].snippet.endsWith("…")).toBe(true)
			expect(hits[0].snippet.length).toBeLessThanOrEqual(122)
		})

		it("falls back to the session manifest title for threads missing from history", async () => {
			await writeSession(sessionsDir, "s1", [textMessage("user", "needle", 100)], {
				manifest: { prompt: "p", metadata: { title: "first message", threadTitle: "Renamed thread" } },
			})
			const hits = await searcher.search({ query: "needle", kind: "messages" })
			expect(hits[0].title).toBe("Renamed thread")
		})

		it("skips malformed message files instead of failing", async () => {
			const dir = path.join(sessionsDir, "broken")
			await fs.mkdir(dir, { recursive: true })
			await fs.writeFile(path.join(dir, "broken.messages.json"), "{not json", "utf8")
			await fs.writeFile(path.join(sessionsDir, "stray-file.txt"), "needle", "utf8")
			await writeSession(sessionsDir, "good", [textMessage("user", "needle", 100)], { mtimeMs: 5000 })

			const hits = await searcher.search({ query: "needle", kind: "messages" })
			expect(hits.map((h) => h.threadId)).toEqual(["good"])
		})

		it("skips message files larger than the per-file byte cap", async () => {
			const capped = new HistorySearcher({ sessionsDir, taskGroupsDir, maxFileBytes: 512 })
			await writeSession(sessionsDir, "big", [textMessage("user", `needle ${"x".repeat(600)}`, 100)])
			await writeSession(sessionsDir, "small", [textMessage("user", "needle", 100)])

			const hits = await capped.search({ query: "needle", kind: "messages" })
			expect(hits.map((h) => h.threadId)).toEqual(["small"])
		})

		it("evicts least-recently-used cache entries once the byte budget is exceeded", async () => {
			// One byte of budget: each cached file evicts every older entry.
			const tight = new HistorySearcher({ sessionsDir, taskGroupsDir, maxCacheBytes: 1 })
			await writeSession(sessionsDir, "s1", [textMessage("user", "alpha needle", 100)], { mtimeMs: 1000 })
			const s2 = await writeSession(sessionsDir, "s2", [textMessage("user", "bravo needle", 200)], { mtimeMs: 2000 })
			expect(await tight.search({ query: "needle", kind: "messages" })).toHaveLength(2)

			// s2 was evicted when s1 was cached, so rewriting it with same-length
			// content at the same mtime is re-read instead of served stale.
			const original = await fs.readFile(s2, "utf8")
			const updated = original.replace("bravo", "omega")
			expect(updated.length).toBe(original.length)
			await fs.writeFile(s2, updated, "utf8")
			const mtime = new Date(2000)
			await fs.utimes(s2, mtime, mtime)

			const hits = await tight.search({ query: "needle", kind: "messages" })
			expect(hits.find((h) => h.threadId === "s2")?.snippet).toContain("omega")
		})

		it("stops scanning when a newer request cancels it", async () => {
			await writeSession(sessionsDir, "s1", [textMessage("user", "needle", 100)], { mtimeMs: 1000 })
			await writeSession(sessionsDir, "s2", [textMessage("user", "needle", 200)], { mtimeMs: 2000 })
			await writeSession(sessionsDir, "s3", [textMessage("user", "needle", 300)], { mtimeMs: 3000 })

			// isCancelled is checked once between scan phases and once per file;
			// allow the phase check plus the newest file, then cancel.
			let calls = 0
			const hits = await searcher.search({ query: "needle", kind: "messages", isCancelled: () => ++calls > 2 })
			expect(hits.map((h) => h.threadId)).toEqual(["s3"])
		})

		it("invalidates the file cache when mtime or size changes", async () => {
			const filePath = await writeSession(sessionsDir, "s1", [textMessage("user", "alpha needle", 100)], {
				mtimeMs: 10_000,
			})
			expect(await searcher.search({ query: "needle", kind: "messages" })).toHaveLength(1)

			// Same size + same mtime keeps serving the cached parse.
			const sameSize = JSON.stringify({ version: 1, sessionId: "s1", messages: [textMessage("user", "omega needle", 100)] })
			const original = await fs.readFile(filePath, "utf8")
			expect(sameSize.length).toBe(original.length)
			await fs.writeFile(filePath, sameSize, "utf8")
			const mtime = new Date(10_000)
			await fs.utimes(filePath, mtime, mtime)
			const stale = await searcher.search({ query: "needle", kind: "messages" })
			expect(stale).toHaveLength(1)
			expect(stale[0].snippet).toContain("alpha")

			// A changed mtime re-parses.
			await fs.utimes(filePath, mtime, new Date(20_000))
			const fresh = await searcher.search({ query: "needle", kind: "messages" })
			expect(fresh[0].snippet).toContain("omega")
		})
	})

	describe("notes", () => {
		it("matches note bodies across task groups", async () => {
			const groups = new TaskGroupStore(taskGroupsDir)
			const notebook = new NotebookStore(taskGroupsDir)
			const group = await groups.createGroup({ title: "g" })
			const note = await notebook.createNote(group.id, { name: "Dev Plan", description: "steps" })
			await fs.appendFile(note.path, "the deployment checklist lives here")

			const hits = await searcher.search({ query: "checklist", kind: "notes" })
			expect(hits).toHaveLength(1)
			expect(hits[0].kind).toBe("note")
			expect(hits[0].id).toBe("dev-plan")
			expect(hits[0].title).toBe("Dev Plan")
			expect(hits[0].taskGroupId).toBe(group.id)
			expect(hits[0].snippet).toContain("checklist")
		})

		it("matches note names and descriptions and ranks them above body hits", async () => {
			const groups = new TaskGroupStore(taskGroupsDir)
			const group = await groups.createGroup({ title: "g" })
			// The body hit is the newest note, so a pure recency sort would rank
			// it first.
			await writeNote(taskGroupsDir, group.id, "name-hit", {
				name: "Needle plans",
				description: "deploy steps",
				body: "unrelated body",
				updated: "2026-01-20T00:00:00.000Z",
			})
			await writeNote(taskGroupsDir, group.id, "desc-hit", {
				name: "other",
				description: "needle in the description",
				body: "",
				updated: "2026-01-10T00:00:00.000Z",
			})
			await writeNote(taskGroupsDir, group.id, "body-hit", {
				name: "misc",
				description: "",
				body: "the needle is only in the body",
				updated: "2026-02-01T00:00:00.000Z",
			})

			const hits = await searcher.search({ query: "needle", kind: "notes" })
			expect(hits.map((h) => h.id)).toEqual(["name-hit", "desc-hit", "body-hit"])
			// Meta hits surface the description as their snippet.
			expect(hits[0].snippet).toBe("deploy steps")
			expect(hits[1].snippet).toBe("needle in the description")
			expect(hits[2].snippet).toContain("needle is only in the body")
		})

		it("an already-cancelled search reads no note files or the activity log", async () => {
			const groups = new TaskGroupStore(taskGroupsDir)
			const group = await groups.createGroup({ title: "g" })
			await writeNote(taskGroupsDir, group.id, "a-note", {
				name: "alpha",
				description: "",
				body: "needle",
				updated: "2026-01-01T00:00:00.000Z",
			})
			await fs.writeFile(
				path.join(taskGroupsDir, group.id, "activity.jsonl"),
				'{"ts":1,"threadId":"t","kind":"read","slug":"a-note"}\n',
				"utf8",
			)

			const readSpy = vi.spyOn(fs, "readFile")
			try {
				const hits = await searcher.search({ query: "needle", kind: "notes", isCancelled: () => true })
				expect(hits).toEqual([])
				const readPaths = readSpy.mock.calls.map(([filePath]) => String(filePath))
				const noteReads = readPaths.filter(
					(filePath) => filePath.includes(`${path.sep}notebook${path.sep}`) || filePath.endsWith("activity.jsonl"),
				)
				expect(noteReads).toEqual([])
			} finally {
				readSpy.mockRestore()
			}
		})

		it("stops reading note files between files once cancelled", async () => {
			const groups = new TaskGroupStore(taskGroupsDir)
			const group = await groups.createGroup({ title: "g" })
			await writeNote(taskGroupsDir, group.id, "a-note", {
				name: "alpha",
				description: "",
				body: "needle",
				updated: "2026-01-01T00:00:00.000Z",
			})
			await writeNote(taskGroupsDir, group.id, "b-note", {
				name: "bravo",
				description: "",
				body: "needle",
				updated: "2026-01-02T00:00:00.000Z",
			})

			const readSpy = vi.spyOn(fs, "readFile")
			try {
				// Allow the group check plus the newest note (b-note), then cancel:
				// the older a-note's body is never read.
				let calls = 0
				await searcher.search({ query: "needle", kind: "notes", isCancelled: () => ++calls > 2 })
				const readPaths = readSpy.mock.calls.map(([filePath]) => String(filePath))
				expect(readPaths.some((filePath) => filePath.endsWith("a-note.md"))).toBe(false)
			} finally {
				readSpy.mockRestore()
			}
		})

		it("skips note files larger than the per-file byte cap", async () => {
			const capped = new HistorySearcher({ sessionsDir, taskGroupsDir, maxFileBytes: 512 })
			const groups = new TaskGroupStore(taskGroupsDir)
			const group = await groups.createGroup({ title: "g" })
			// The oversized note matches on its name too: the cap skips it
			// entirely, before any read.
			await writeNote(taskGroupsDir, group.id, "big", {
				name: "needle",
				description: "",
				body: `needle ${"x".repeat(600)}`,
				updated: "2026-01-01T00:00:00.000Z",
			})
			await writeNote(taskGroupsDir, group.id, "small", {
				name: "misc",
				description: "",
				body: "needle",
				updated: "2026-01-02T00:00:00.000Z",
			})

			const hits = await capped.search({ query: "needle", kind: "notes" })
			expect(hits.map((h) => h.id)).toEqual(["small"])
		})

		it("serves note parses from the size-bounded cache until mtime or size changes", async () => {
			const groups = new TaskGroupStore(taskGroupsDir)
			const group = await groups.createGroup({ title: "g" })
			await writeNote(taskGroupsDir, group.id, "cached", {
				name: "misc",
				description: "",
				body: "alpha needle",
				updated: "2026-01-01T00:00:00.000Z",
			})
			const filePath = path.join(taskGroupsDir, group.id, "notebook", "cached.md")
			expect(await searcher.search({ query: "needle", kind: "notes" })).toHaveLength(1)

			// Same size + same mtime keeps serving the cached parse.
			const original = await fs.readFile(filePath, "utf8")
			const updated = original.replace("alpha", "omega")
			expect(updated.length).toBe(original.length)
			await fs.writeFile(filePath, updated, "utf8")
			const mtime = new Date("2026-01-01T00:00:00.000Z")
			await fs.utimes(filePath, mtime, mtime)

			const stale = await searcher.search({ query: "needle", kind: "notes" })
			expect(stale).toHaveLength(1)
			expect(stale[0].snippet).toContain("alpha")

			// A changed mtime re-parses.
			await fs.utimes(filePath, mtime, new Date("2026-02-01T00:00:00.000Z"))
			const fresh = await searcher.search({ query: "needle", kind: "notes" })
			expect(fresh[0].snippet).toContain("omega")
		})
	})

	describe("kinds and ranking", () => {
		it("returns nothing for client-side kinds", async () => {
			await writeSession(sessionsDir, "s1", [textMessage("user", "needle", 100)])
			expect(await searcher.search({ query: "needle", kind: "tasks" })).toEqual([])
			expect(await searcher.search({ query: "needle", kind: "threads" })).toEqual([])
		})

		it("merges note and message hits newest-first under kind all", async () => {
			const groups = new TaskGroupStore(taskGroupsDir)
			const notebook = new NotebookStore(taskGroupsDir)
			const group = await groups.createGroup({ title: "g" })
			const note = await notebook.createNote(group.id, { name: "Plan", description: "" })
			await fs.appendFile(note.path, "needle in a note")
			// A message newer than the note sorts above it.
			const noteStat = await fs.stat(note.path)
			await writeSession(sessionsDir, "s1", [textMessage("assistant", "needle in chat", noteStat.mtimeMs + 1000)])

			const hits = await searcher.search({ query: "needle", kind: "all" })
			expect(hits.map((h) => h.kind)).toEqual(["message", "note"])
		})

		it("returns [] for blank queries", async () => {
			await writeSession(sessionsDir, "s1", [textMessage("user", "needle", 100)])
			expect(await searcher.search({ query: "   ", kind: "all" })).toEqual([])
		})
	})
})
