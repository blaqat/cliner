import { type AgentTool, createTool } from "@cline/shared"
import type { NotebookChange } from "@shared/task-groups"
import type { TaskNotebookContext } from "./notebook-context"
import { slugifyNoteName } from "./notebook-store"

interface NotebookInput {
	action: "read" | "write" | "delete"
	name: string
	description?: string
	content?: string
}

export async function createNotebookTool(notebook: TaskNotebookContext): Promise<AgentTool> {
	const { group, rootThreadId, store } = notebook
	await store.listNotes(group.id)
	const baseDescription =
		"Read, write or delete notes shared by this task's threads. Use a note's slug or name. " +
		"Writes and deletes are staged for the user to review when you finish, including in Ask mode. " +
		"Only read loads a note's body."
	const tool = createTool<NotebookInput, string | { error: string }>({
		name: "notebook",
		metadata: { subagentAccess: "read" },
		description: baseDescription,
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["read", "write", "delete"] },
				name: { type: "string", description: "Note slug or name" },
				description: { type: "string" },
				content: { type: "string", description: "Markdown body for write" },
			},
			required: ["action", "name"],
		},
		retryable: false,
		execute: async (input, context) => {
			try {
				if (!input.name?.trim() || !["read", "write", "delete"].includes(input.action)) {
					return { error: "A note name and action (read, write or delete) are required." }
				}
				const notes = await store.listNotes(group.id)
				const pending = (await store.readPending(group.id, rootThreadId)) ?? []
				const slug = slugifyNoteName(input.name)
				if (!slug) return { error: "Use a note name containing letters or numbers." }
				const existing = [...notes, ...pending].find(
					(note) => note.slug === input.name || note.name === input.name || note.slug === slug,
				)
				const noteSlug = existing?.slug ?? slug
				if (input.action === "read") {
					const readerThreadId = notebook.resolveReaderThreadId?.(context.agentId) ?? notebook.threadId
					const note = await store.readThreadNote(group.id, rootThreadId, noteSlug, readerThreadId)
					return note ? note.content : { error: `Note not found: ${input.name}` }
				}
				if (input.action === "write" && typeof input.content !== "string") {
					return { error: "content is required for write." }
				}
				if (input.action === "delete" && !existing) return { error: `Note not found: ${input.name}` }
				const saved = notes.find((note) => note.slug === noteSlug)
				const staged = pending.find((note) => note.slug === noteSlug)
				const change: NotebookChange = {
					op: input.action === "delete" ? "delete" : saved ? "update" : "create",
					slug: noteSlug,
					name: staged?.name ?? saved?.name ?? input.name.trim(),
					description: input.description ?? staged?.description ?? saved?.description ?? "",
					...(input.action === "write" ? { content: input.content } : {}),
					baseUpdatedAt: staged?.baseUpdatedAt ?? saved?.updatedAt,
				}
				await store.stageChange(group.id, rootThreadId, change)
				return "Staged; the user reviews notebook changes when you finish."
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})
	Object.defineProperty(tool, "description", {
		get() {
			const notes = store.getNoteIndex(group.id)
			const index = notes.slice(0, 40).map((note) => `- ${note.slug}: ${note.name}. ${note.description}`)
			if (notes.length > 40) index.push(`${notes.length - 40} more; read by name`)
			return `${baseDescription}\n\nTask notes:\n${index.join("\n") || "No notes yet."}`
		},
		enumerable: true,
		configurable: true,
	})
	return tool as AgentTool
}
