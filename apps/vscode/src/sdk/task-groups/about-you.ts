import { type AgentTool, createTool } from "@cline/shared"
import {
	ABOUT_YOU_ID,
	ABOUT_YOU_TOKEN_CAP,
	ABOUT_YOU_WARN_TOKENS,
	estimateTokens,
	type NotebookChange,
	type NotebookNoteMeta,
} from "@shared/task-groups"
import type { NotebookStore } from "./notebook-store"
import { slugifyNoteName } from "./notebook-store"

/** The thread whose chat reviews About you proposals (a subagent's root thread). */
export interface AboutYouContext {
	rootThreadId: string
	store: NotebookStore
}

/** Tokens About you costs in every request: the sum of its notes' bodies. */
export function aboutYouTokens(notes: Pick<NotebookNoteMeta, "tokens">[]): number {
	return notes.reduce((sum, note) => sum + (note.tokens ?? 0), 0)
}

/** About you guidance and any saved notes, sorted by name for a stable system prompt. */
export async function aboutYouPrompt(store: NotebookStore): Promise<string> {
	const notes = [...(await store.listNotes(ABOUT_YOU_ID))].sort((a, b) => a.name.localeCompare(b.name))
	const sections: string[] = []
	for (const note of notes) {
		const body = (await store.readNote(ABOUT_YOU_ID, note.slug))?.content.trim()
		if (body) sections.push(`## ${note.name}\n\n${body}`)
	}
	return [
		"# About the user",
		"About you holds lasting facts about the user, such as preferences, working style and environment. " +
			"They apply across workspaces. Follow them unless the user says otherwise here.",
		"Use the task notebook for notes about the current work, including plans, decisions and progress. " +
			"If the user asks to save work notes and the notebook tool is unavailable, explain that work notes live in a task " +
			"and offer to put this thread in a task first.",
		...sections,
	].join("\n\n")
}

interface AboutYouInput {
	action: "write" | "delete"
	name: string
	content?: string
	summary?: string
}

/**
 * Lets the agent propose About you changes when the user asks it to remember a
 * general preference. Like notebook writes, they are staged and reviewed in the
 * same row at the end of the turn; nothing applies silently. The cap holds for
 * the agent: past the warning line it may only shorten or replace.
 */
export function createAboutYouTool(context: AboutYouContext): AgentTool {
	const { store, rootThreadId } = context
	const baseDescription =
		"Propose a change to About you, the global notebook included in every thread in every workspace. " +
		"Use it only when the user asks you to remember lasting facts about themselves: preferences, working style " +
		"or their environment, such as how they like answers or which shell they use. Never save task or project " +
		"notes, plans, decisions, progress, research or work summaries here, even if the user says 'save notes' " +
		"or 'remember this'. Use the notebook tool for those. If no notebook tool is available, this thread has no " +
		"task notebook. Tell the user that work notes live in a task and offer to put this thread in a task first. " +
		"Do not claim you moved the thread or saved work notes. Changes are staged for the user " +
		`to review when you finish. About you is capped at ${ABOUT_YOU_TOKEN_CAP.toLocaleString("en-US")} tokens; ` +
		`from ${ABOUT_YOU_WARN_TOKENS} you may only shorten or replace notes. Keep each line short.`
	const tool = createTool<AboutYouInput, string | { error: string }>({
		name: "about_you",
		description: baseDescription,
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["write", "delete"] },
				name: { type: "string", description: "Note name, e.g. Tools or Writing" },
				content: { type: "string", description: "The note's full markdown body for write" },
				summary: { type: "string", description: "One short line for the user: what this changes" },
			},
			required: ["action", "name"],
		},
		retryable: false,
		execute: async (input) => {
			try {
				if (!input.name?.trim() || !["write", "delete"].includes(input.action)) {
					return { error: "A note name and action (write or delete) are required." }
				}
				const slug = slugifyNoteName(input.name)
				if (!slug) return { error: "Use a note name containing letters or numbers." }
				const notes = await store.listNotes(ABOUT_YOU_ID)
				const pending = (await store.readPending(ABOUT_YOU_ID, rootThreadId)) ?? []
				const existing = [...notes, ...pending].find(
					(note) => note.slug === input.name || note.name === input.name || note.slug === slug,
				)
				const noteSlug = existing?.slug ?? slug
				if (input.action === "write" && typeof input.content !== "string") {
					return { error: "content is required for write." }
				}
				if (input.action === "delete" && !existing) return { error: `Note not found: ${input.name}` }
				const saved = notes.find((note) => note.slug === noteSlug)
				const staged = pending.find((note) => note.slug === noteSlug)
				if (input.action === "write") {
					// Size as it would be once every staged change is kept.
					const stagedTokens = (slugToSkip: string) =>
						pending
							.filter((change) => change.slug !== slugToSkip && change.op !== "delete")
							.reduce((sum, change) => sum + estimateTokens(change.content ?? ""), 0)
					const savedTokens = (slugToSkip: string) =>
						aboutYouTokens(
							notes.filter(
								(note) => note.slug !== slugToSkip && !pending.some((change) => change.slug === note.slug),
							),
						)
					const before =
						savedTokens(noteSlug) +
						stagedTokens(noteSlug) +
						(staged ? estimateTokens(staged.content ?? "") : (saved?.tokens ?? 0))
					const after = savedTokens(noteSlug) + stagedTokens(noteSlug) + estimateTokens(input.content ?? "")
					if (after > ABOUT_YOU_TOKEN_CAP) {
						return {
							error: `About you would be ${after} of ${ABOUT_YOU_TOKEN_CAP} tokens. Shorten or replace an existing note instead, or tell the user it's full.`,
						}
					}
					if (before >= ABOUT_YOU_WARN_TOKENS && after > before) {
						return {
							error: `About you is nearly full (${before} of ${ABOUT_YOU_TOKEN_CAP} tokens). Only shorten or replace notes.`,
						}
					}
				}
				const change: NotebookChange = {
					op: input.action === "delete" ? "delete" : saved ? "update" : "create",
					slug: noteSlug,
					name: staged?.name ?? saved?.name ?? input.name.trim(),
					description: staged?.description ?? saved?.description ?? "",
					...(input.action === "write" ? { content: input.content } : {}),
					...(input.summary?.trim() ? { summary: input.summary.trim().slice(0, 200) } : {}),
					baseUpdatedAt: staged?.baseUpdatedAt ?? saved?.updatedAt,
				}
				await store.stageChange(ABOUT_YOU_ID, rootThreadId, change)
				return "Staged; the user reviews About you changes when you finish."
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})
	Object.defineProperty(tool, "description", {
		get() {
			const notes = store.getNoteIndex(ABOUT_YOU_ID)
			const index = notes.map((note) => `- ${note.name} (${note.tokens ?? 0} tokens)`)
			return `${baseDescription}\n\nAbout you now (${aboutYouTokens(notes)} of ${ABOUT_YOU_TOKEN_CAP} tokens):\n${index.join("\n") || "Empty."}`
		},
		enumerable: true,
		configurable: true,
	})
	return tool as AgentTool
}
