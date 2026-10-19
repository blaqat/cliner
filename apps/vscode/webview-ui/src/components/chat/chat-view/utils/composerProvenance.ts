import { ComposerProvenance, MessageLinkRef, ScriptInvocation } from "@shared/proto/cline/common"
import type { ScriptValues } from "@shared/scripts"
import type { MessageTagDraft } from "../types/chatTypes"

/**
 * What the user explicitly did in the composer, kept next to the draft text.
 * The host authorizes exactly this when the message is sent and nothing it
 * could infer from the text, because the text also holds "Add to Cline"
 * insertions, restored drafts and quote chips.
 */
export interface DraftAuthorization {
	/** Thread ids picked from the `thread:` mention menu. */
	authorizedThreadIds: readonly string[]
	/** The saved script the user typed or picked, with the option values the helper strip shows. */
	scriptRun?: { name: string; values: ScriptValues }
}

export const NO_AUTHORIZATION: DraftAuthorization = { authorizedThreadIds: [] }

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Whether `text` still holds the `thread:<id>` token the menu inserted (same boundaries as the host). */
export function hasThreadToken(text: string, id: string): boolean {
	return new RegExp(`(?<![\\w/@#.])thread:${escapeRegExp(id)}(?![0-9A-Za-z_-])`).test(text)
}

/** Whether `text` still starts with `/<name> `, the shape of a script run. */
export function startsWithScript(text: string, name: string): boolean {
	return new RegExp(`^\\s*/${escapeRegExp(name)}[ \\t]`).test(text)
}

/** Drops grants whose token or script prefix was deleted from the text. */
export function pruneAuthorization(text: string, auth: DraftAuthorization): DraftAuthorization {
	const granted = auth.authorizedThreadIds ?? []
	const ids = granted.filter((id) => hasThreadToken(text, id))
	const scriptRun = auth.scriptRun && startsWithScript(text, auth.scriptRun.name) ? auth.scriptRun : undefined
	if (ids.length === granted.length && scriptRun === auth.scriptRun) return auth
	return { authorizedThreadIds: ids, scriptRun }
}

/** The part of a message tag the host needs to resolve its text. */
type MessageTagTarget = Pick<MessageTagDraft, "threadId" | "messageIndex" | "toolCallId" | "block">

/**
 * The explicit-action field sent with a message, or undefined when the draft carries none.
 * Message tags ride along as context links only; they never add to `authorizedThreadIds`.
 */
export function toComposerProvenance(
	text: string,
	auth: DraftAuthorization,
	messageTags: readonly MessageTagTarget[] = [],
): ComposerProvenance | undefined {
	const live = pruneAuthorization(text, auth)
	if (live.authorizedThreadIds.length === 0 && !live.scriptRun && messageTags.length === 0) return undefined
	const values: Record<string, string> = {}
	const flags: Record<string, boolean> = {}
	for (const [name, value] of Object.entries(live.scriptRun?.values ?? {})) {
		if (typeof value === "boolean") flags[name] = value
		else values[name] = value
	}
	return ComposerProvenance.create({
		authorizedThreadIds: [...live.authorizedThreadIds],
		...(messageTags.length > 0
			? {
					messageLinks: messageTags.map((tag) =>
						MessageLinkRef.create({
							threadId: tag.threadId,
							messageIndex: tag.messageIndex,
							toolCallId: tag.toolCallId,
							block: tag.block,
						}),
					),
				}
			: {}),
		scriptInvocation: live.scriptRun ? ScriptInvocation.create({ name: live.scriptRun.name, values, flags }) : undefined,
	})
}
