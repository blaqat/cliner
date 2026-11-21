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
		expect(tools.map((tool) => tool.name)).toEqual(["present_walkthrough", "about_you", "skill_draft"])
	})

	it("routes work notes to a task and offers filing when the thread has no notebook", async () => {
		const tools = await createVscodeExtraTools({ getServers: () => [] } as never, { aboutYou: { rootThreadId: "t", store } })
		expect(tools.find((tool) => tool.name === "notebook")).toBeUndefined()
		const description = tools.find((tool) => tool.name === "about_you")!.description
		expect(description).toContain("lasting facts about themselves")
		expect(description).toContain(
			"Never save task or project notes, plans, decisions, progress, research or work summaries here",
		)
		expect(description).toContain("Tell the user that work notes live in a task and offer to put this thread in a task first")
		expect(description).toContain("Do not claim you moved the thread or saved work notes")
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
		expect(prompt).toContain("Use the task notebook for notes about the current work")
		expect(prompt).toContain("If the user asks to save work notes and the notebook tool is unavailable")
		expect(prompt).toContain("offer to put this thread in a task first")
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
