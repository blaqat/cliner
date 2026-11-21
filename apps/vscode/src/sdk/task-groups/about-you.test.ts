import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentToolContext } from "@cline/shared"
import { ABOUT_YOU_ID } from "@shared/task-groups"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createVscodeExtraTools } from "../vscode-runtime-builder"
import { aboutYouPrompt, createAboutYouTool } from "./about-you"
import { NotebookStore } from "./notebook-store"
import { TaskGroupStore } from "./task-group-store"

describe("About you", () => {
	let root: string
	let store: NotebookStore
	const context = {} as AgentToolContext
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-about-you-"))
		store = new NotebookStore(root)
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("is offered to every thread, not only threads in a task", async () => {
		const hub = { getServers: () => [] } as never
		const tools = await createVscodeExtraTools(hub, { aboutYou: { rootThreadId: "t", store } })
		expect(tools.map((tool) => tool.name)).toEqual(["present_walkthrough", "notebook", "about_you", "skill_draft"])
	})

	it("routes work notes to a task and offers filing when the thread has no notebook", async () => {
		const tools = await createVscodeExtraTools({ getServers: () => [] } as never, { aboutYou: { rootThreadId: "t", store } })
		const input = {
			action: "write",
			name: "Project notes - blue dashboard with daily totals",
			content: "We are planning to create a small blue dashboard that displays daily totals.",
		}
		const aboutYou = tools.find((tool) => tool.name === "about_you")!
		expect(await aboutYou.execute(input, context)).toEqual({ error: expect.stringContaining("notebook") })
		expect(await store.readPending(ABOUT_YOU_ID, "t")).toBeUndefined()
		const notebook = tools.find((tool) => tool.name === "notebook")!
		expect(await notebook.execute(input, context)).toEqual({
			error: expect.stringContaining("Ask the user"),
		})
		expect(await store.listPending("t")).toEqual([])
	})

	it("stages a work note and a personal preference in their own notebooks for the same thread", async () => {
		const group = await new TaskGroupStore(root).createGroup({ title: "Dashboard" })
		const tools = await createVscodeExtraTools({ getServers: () => [] } as never, {
			notebook: { group, threadId: "t", rootThreadId: "t", store },
			aboutYou: { rootThreadId: "t", store },
		})
		const notebook = tools.find((tool) => tool.name === "notebook")!
		const aboutYou = tools.find((tool) => tool.name === "about_you")!
		const personal = { action: "write", name: "About Me", content: "Prefers concise answers." }
		expect(await notebook.execute(personal, context)).toEqual({ error: expect.stringContaining("about_you") })
		expect(
			await notebook.execute(
				{ action: "write", name: "Task Notes", content: "The dashboard reports daily support tickets." },
				context,
			),
		).toContain("Staged")
		expect(await aboutYou.execute(personal, context)).toContain("Staged")
		expect(await store.readPending(group.id, "t")).toEqual([expect.objectContaining({ name: "Task Notes" })])
		expect(await store.readPending(ABOUT_YOU_ID, "t")).toEqual([expect.objectContaining({ name: "About Me" })])
	})

	it("stages proposals for review in the thread, with the agent's summary", async () => {
		const tool = createAboutYouTool({ rootThreadId: "t", store })
		const result = await tool.execute(
			{ action: "write", name: "Tools", content: "- Use pnpm, never npm.", summary: "You said: always pnpm" },
			context,
		)
		expect(result).toContain("Staged")
		expect(await store.listNotes(ABOUT_YOU_ID)).toEqual([])
		expect(await store.readPending(ABOUT_YOU_ID, "t")).toEqual([
			expect.objectContaining({
				op: "create",
				slug: "tools",
				content: "- Use pnpm, never npm.",
				summary: "You said: always pnpm",
			}),
		])
	})

	it("blocks a proposal past the cap and adds once nearly full, but still allows shortening", async () => {
		const tool = createAboutYouTool({ rootThreadId: "t", store })
		expect(await tool.execute({ action: "write", name: "Huge", content: "x".repeat(4004) }, context)).toEqual({
			error: expect.stringContaining("1001 of 1000 tokens"),
		})
		await store.createNote(ABOUT_YOU_ID, { name: "Style", description: "" })
		await store.saveNote(ABOUT_YOU_ID, "style", { content: "y".repeat(3200) })
		expect(await tool.execute({ action: "write", name: "More", content: "a line" }, context)).toEqual({
			error: expect.stringContaining("nearly full"),
		})
		expect(await tool.execute({ action: "write", name: "Style", content: "y".repeat(100) }, context)).toContain("Staged")
	})

	it("tells the model where work notes go even when About you is empty", async () => {
		const prompt = await aboutYouPrompt(store)
		expect(prompt).toContain("About you holds lasting facts about the user")
		expect(prompt).toContain("`notebook` for current work")
		expect(prompt).toContain("propose each change in its respective notebook")
	})

	it("puts saved About you facts in the system prompt", async () => {
		await store.createNote(ABOUT_YOU_ID, { name: "Writing", description: "" })
		await store.saveNote(ABOUT_YOU_ID, "writing", { content: "Short commit messages." })
		const prompt = await aboutYouPrompt(store)
		expect(prompt).toContain("# About the user")
		expect(prompt).toContain("## Writing\n\nShort commit messages.")
	})

	it("never lists as a task", async () => {
		await store.createNote(ABOUT_YOU_ID, { name: "Writing", description: "" })
		expect(await new TaskGroupStore(root).listGroups()).toEqual([])
	})
})
