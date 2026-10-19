import type { MessageTagDraft, QuoteDraft } from "../types/chatTypes"

/** Mirrors `ExtensionState.promptStash` entries (see AGENT_BRIEF contract). */
export interface PromptStashEntry {
	id: string
	text: string
	quotes: QuoteDraft[]
	/** Absent in entries stashed before message tags existed. */
	messageTags?: MessageTagDraft[]
	ts: number
	taskId?: string
}

export interface StashableDraft {
	text: string
	quotes: QuoteDraft[]
	messageTags?: MessageTagDraft[]
}

export function isDraftEmpty(draft: StashableDraft): boolean {
	return !draft.text.trim() && draft.quotes.length === 0 && !draft.messageTags?.length
}

export function createStashId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Returns the stash with `draft` added as the newest entry, or the same array when the draft is empty. */
export function pushStashEntry(
	entries: readonly PromptStashEntry[],
	draft: StashableDraft,
	meta: { id: string; ts: number; taskId?: string },
): PromptStashEntry[] {
	if (isDraftEmpty(draft)) {
		return entries as PromptStashEntry[]
	}
	const entry: PromptStashEntry = {
		id: meta.id,
		text: draft.text,
		quotes: draft.quotes.map((quote) => ({ ...quote })),
		...(draft.messageTags?.length ? { messageTags: draft.messageTags.map((tag) => ({ ...tag })) } : {}),
		ts: meta.ts,
		...(meta.taskId ? { taskId: meta.taskId } : {}),
	}
	return [entry, ...entries]
}

/**
 * Removes entry `id` from the stash. If the current draft is non-empty it is
 * swapped into the stash so restoring never loses typed text.
 */
export function takeStashEntry(
	entries: readonly PromptStashEntry[],
	id: string,
	currentDraft: StashableDraft,
	swapMeta: { id: string; ts: number; taskId?: string },
): { entries: PromptStashEntry[]; restored: PromptStashEntry | undefined } {
	const restored = entries.find((entry) => entry.id === id)
	if (!restored) {
		return { entries: entries as PromptStashEntry[], restored: undefined }
	}
	const remaining = entries.filter((entry) => entry.id !== id)
	return { entries: pushStashEntry(remaining, currentDraft, swapMeta), restored }
}

export function removeStashEntry(entries: readonly PromptStashEntry[], id: string): PromptStashEntry[] {
	return entries.filter((entry) => entry.id !== id)
}

/** Label for a stash row: the text, or a count when only quotes / message tags were stashed. */
export function describeStashEntry(entry: PromptStashEntry): string {
	const text = entry.text.trim()
	if (text) {
		return text
	}
	if (entry.quotes.length === 0 && entry.messageTags?.length) {
		return `(${entry.messageTags.length} message${entry.messageTags.length === 1 ? "" : "s"})`
	}
	return `(${entry.quotes.length} quote${entry.quotes.length === 1 ? "" : "s"})`
}
