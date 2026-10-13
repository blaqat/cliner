import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentToolContext } from "@cline/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { expandTaskNoteMentions } from "@/core/mentions/task-notes"
import { createVscodeExtraTools } from "../vscode-runtime-builder"
import { resolveNotebookOwner } from "./notebook-context"
import { NotebookStore } from "./notebook-store"
import { createNotebookTool } from "./notebook-tool"
import { TaskGroupStore, taskGroupPaths } from "./task-group-store"

describe("task notebook agent tool", () => {
	let root: string
	let store: NotebookStore
	let group: Awaited<ReturnType<TaskGroupStore["createGroup"]>>
	const context = { agentId: "child-agent" } as AgentToolContext
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-notebook-tool-"))
		store = new NotebookStore(root)
		group = await new TaskGroupStore(root).createGroup({ title: "Task" })
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	const makeTool = () =>
		createNotebookTool({ group, threadId: "root", rootThreadId: "root", store, resolveReaderThreadId: () => "child" })

	it("registers notebook only for grouped threads and exposes it to reader subagents", async () => {
		const hub = { getServers: () => [] } as never
		expect(await createVscodeExtraTools(hub)).toEqual([])
		const tools = await createVscodeExtraTools(hub, {
			notebook: { group, threadId: "root", rootThreadId: "root", store },
		})
		expect(tools.map((tool) => tool.name)).toEqual(["notebook"])
		expect(tools[0].metadata?.subagentAccess).toBe("read")
	})

	it("indexes the 40 latest notes through a getter and refreshes hand edits", async () => {
		for (let i = 0; i < 42; i++) {
			await store.createNote(group.id, { name: `Note ${i}`, description: `Description ${i}` })
		}
		const tool = await makeTool()
		expect(Object.getOwnPropertyDescriptor(tool, "description")?.get).toBeTypeOf("function")
		expect(tool.description.match(/^- /gm)).toHaveLength(40)
		expect(tool.description).toContain("2 more; read by name")
		await fs.writeFile(store.notePath(group.id, "note-41"), "---\nname: Changed\ndescription: Hand edit\n---\nSecret body")
		await store.refreshNoteIndexes()
		expect(tool.description).toContain("note-41: Changed. Hand edit")
		expect(tool.description).not.toContain("Secret body")
	})

	it("stages writes, reads the staged body and applies user edits with attribution", async () => {
		const tool = await makeTool()
		expect(await tool.execute({ action: "write", name: "Dev plan", description: "Steps", content: "Draft" }, context)).toBe(
			"Staged; the user reviews notebook changes when you finish.",
		)
		expect(await store.readNote(group.id, "dev-plan")).toBeUndefined()
		expect(await tool.execute({ action: "read", name: "dev-plan" }, context)).toBe("Draft")
		const applied = await store.applyPendingChanges(
			group.id,
			"root",
			(await store.readPendingReview(group.id, "root"))!.revision,
			[{ slug: "dev-plan", include: true, editedContent: "Reviewed" }],
			{ threadTitle: "Title" },
		)
		expect(applied[0].content).toBe("Reviewed")
		expect(await store.readNote(group.id, "dev-plan")).toMatchObject({
			content: "Reviewed",
			meta: { updatedBy: { kind: "thread", threadId: "root", threadTitle: "Title" } },
		})

		expect(await store.listActivity(group.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "read", threadId: "child", slug: "dev-plan" }),
				expect.objectContaining({ kind: "write", threadId: "root", slug: "dev-plan" }),
			]),
		)
		expect(await store.readPending(group.id, "root")).toBeUndefined()
	})

	it("subagents stage into their owning aside without losing parallel changes", async () => {
		const threads = new Map([
			["root", { id: "root", taskGroupId: group.id }],
			["aside", { id: "aside", parentTaskId: "root", taskGroupId: group.id }],
			["child", { id: "child", isSubagent: true, runtimeOwnerTaskId: "aside", parentTaskId: "aside" }],
		])
		const owner = await resolveNotebookOwner(threads.get("child") as never, async (id) => threads.get(id) as never)
		expect(owner).toEqual({ rootThreadId: "aside", taskGroupId: group.id })
		const tool = await createNotebookTool({ group, threadId: "child", rootThreadId: owner.rootThreadId, store })
		await Promise.all(["First", "Second"].map((name) => tool.execute({ action: "write", name, content: name }, context)))
		expect(await store.readPending(group.id, "aside")).toHaveLength(2)
		expect(await store.readPending(group.id, "child")).toBeUndefined()
		await expect(fs.access(taskGroupPaths(root, group.id).pendingFile("aside"))).resolves.toBeUndefined()
	})

	it("stages deletion and cancels a newly created note when deleted", async () => {
		await store.createNote(group.id, { name: "Existing", description: "" })
		const tool = await makeTool()
		await tool.execute({ action: "delete", name: "existing" }, context)
		expect(await store.readNote(group.id, "existing")).toBeDefined()
		expect(await tool.execute({ action: "read", name: "existing" }, context)).toEqual({ error: "Note not found: existing" })
		await store.discardPendingChanges(group.id, "root", (await store.readPendingReview(group.id, "root"))!.revision)
		await tool.execute({ action: "write", name: "New", content: "Draft" }, context)
		await tool.execute({ action: "delete", name: "new" }, context)
		expect(await store.readPending(group.id, "root")).toBeUndefined()
	})

	it("expands only existing #slugs, reads staging, and logs mention reads", async () => {
		const tool = await makeTool()
		await tool.execute({ action: "write", name: 'Dev "plan"', content: "Draft" }, context)
		const text = await expandTaskNoteMentions("Use #dev-plan, #unknown and owner/repo#123. #dev-plan", (slug) =>
			store.readThreadNote(group.id, "root", slug, "root"),
		)
		expect(text).toBe(
			'Use <task_note name="Dev &quot;plan&quot;">\nDraft\n</task_note>, #unknown and owner/repo#123. <task_note name="Dev &quot;plan&quot;">\nDraft\n</task_note>',
		)
		expect(await store.listActivity(group.id)).toHaveLength(1)
	})
	it("an unfiled aside under a grouped parent has no notebook ownership", async () => {
		const aside = { id: "aside", parentTaskId: "root" }
		const find = async () => ({ id: "root", taskGroupId: group.id }) as never
		expect(await resolveNotebookOwner(aside as never, find)).toEqual({ rootThreadId: "aside", taskGroupId: undefined })
		expect(
			await resolveNotebookOwner(
				{ id: "child", isSubagent: true, parentTaskId: "aside" } as never,
				async () => aside as never,
			),
		).toEqual({ rootThreadId: "aside", taskGroupId: undefined })
	})

	it("an aside moved to B stages and expands mentions under its own id in B", async () => {
		const other = await new TaskGroupStore(root).createGroup({ title: "B" })
		const aside = { id: "aside", parentTaskId: "root", taskGroupId: other.id }
		const owner = await resolveNotebookOwner(aside as never, async () => ({ id: "root", taskGroupId: group.id }) as never)
		expect(owner).toEqual({ rootThreadId: "aside", taskGroupId: other.id })
		const tool = await createNotebookTool({ group: other, threadId: "aside", rootThreadId: owner.rootThreadId, store })
		await tool.execute({ action: "write", name: "Plan", content: "B plan" }, context)
		expect(await store.readPending(other.id, "aside")).toHaveLength(1)
		expect(await store.readPending(group.id, "root")).toBeUndefined()
		expect(
			await expandTaskNoteMentions("Use #plan", (slug) =>
				store.readThreadNote(other.id, owner.rootThreadId, slug, "aside"),
			),
		).toContain("B plan")
	})
})
