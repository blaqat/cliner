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
