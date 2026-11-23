import { type AgentTool, createTool } from "@cline/shared"
import type { NotebookChange } from "@shared/task-groups"
import type { TaskNotebookContext } from "./notebook-context"
import { slugifyNoteName } from "./notebook-store"

interface NotebookInput {
	action: "read" | "write" | "delete"
	name: string
	description?: string
	content?: string
	summary?: string
}

const PERSONAL_NOTE_NAME = /^(?:about (?:me|you|the user)|(?:user|personal) preferences?)$/i
const PERSONAL_FACT = /^\s*(?:[-*]\s+)?(?:(?:the )?user\s+|i\s+)?(?:prefers?|likes?|(?:am|is) on (?:macos|windows|linux))\b/im
const WORK_CONTEXT = /\b(?:this|current) (?:task|project|work|workspace|repository)\b/i

export async function createNotebookTool(notebook?: TaskNotebookContext): Promise<AgentTool> {
	if (notebook) await notebook.store.listNotes(notebook.group.id)
	const readFingerprints = new Map<string, string>()
	const baseDescription =
		"Read, write or delete work notes shared by a task's threads, including project facts, plans, decisions and progress. " +
		"Save lasting personal preferences and facts about the user with about_you, even when asked alongside a work note. " +
		"Use a note's slug or name. " +
		"Writes and deletes are staged for the user to review when you finish, including in Ask mode. " +
		"Only read loads a note's body."
	const tool = createTool<NotebookInput, string | { error: string }>({
		name: "notebook",
		metadata: { subagentAccess: "read" },
		description: notebook
			? baseDescription
			: `${baseDescription} This thread must be filed in a task before it can access work notes.`,
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["read", "write", "delete"] },
				name: { type: "string", description: "Note slug or name" },
				description: { type: "string" },
				content: { type: "string", description: "Markdown body for write" },
				summary: {
					type: "string",
					description: "One short line for the user: what this edit changes and why (write and delete)",
				},
			},
			required: ["action", "name"],
		},
		retryable: false,
		execute: async (input, context) => {
			if (!notebook) {
				return {
					error:
						"This thread isn't in a task. Ask the user if they want to file it in a task and which task to use. " +
						"They can use File into a task in the thread's menu. Save the work notes once the thread is in a task.",
				}
			}
			const { group, rootThreadId, store } = notebook
			try {
				if (!input.name?.trim() || !["read", "write", "delete"].includes(input.action)) {
					return { error: "A note name and action (read, write or delete) are required." }
				}
				if (
					input.action === "write" &&
					PERSONAL_NOTE_NAME.test(input.name.trim()) &&
					PERSONAL_FACT.test(input.content ?? "") &&
					!WORK_CONTEXT.test(input.content ?? "")
				) {
					return { error: "This looks like a lasting personal preference. Use about_you for it." }
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
					const note = await store.readThreadNote(group.id, rootThreadId, noteSlug, readerThreadId, (fingerprint) => {
						readFingerprints.set(noteSlug, fingerprint)
					})
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
					...(input.summary?.trim() ? { summary: input.summary.trim().slice(0, 200) } : {}),
					baseUpdatedAt: staged?.baseUpdatedAt ?? saved?.updatedAt,
					baseFingerprint: readFingerprints.get(noteSlug),
				}
				await store.stageChange(group.id, rootThreadId, change)
				return "Staged; the user reviews notebook changes when you finish."
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})
	if (!notebook) return tool as AgentTool
	const { group, store } = notebook
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
