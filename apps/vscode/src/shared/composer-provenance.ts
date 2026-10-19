import type { ScriptValues } from "./scripts"

/**
 * What the user explicitly did in the composer for one message. The host
 * authorizes only what is listed here; it never infers authorization from
 * message text, which can also hold quote chips, "Add to Cline" insertions,
 * restored drafts and expanded notes. Structurally matches the proto message
 * of the same name.
 */
/** A pasted message link attached to the message as context (the host resolves its text). */
export interface MessageLinkRef {
	threadId: string
	messageIndex: number
	toolCallId?: string
	block?: number
}

export interface ComposerProvenance {
	/** Thread ids picked from the `thread:` mention menu whose token is still in the text. */
	authorizedThreadIds?: readonly string[]
	/** The saved script the user typed or picked and sent through the script helper. */
	scriptInvocation?: {
		name: string
		values?: Readonly<Record<string, string>>
		flags?: Readonly<Record<string, boolean>>
	}
	/** Message tags in the composer. Context only: they never authorize a thread's transcript tools. */
	messageLinks?: readonly MessageLinkRef[]
}

const MAX_AUTHORIZED_THREADS = 50
const MAX_MESSAGE_LINKS = 20

/** Valid, deduplicated, capped message links; protobuf defaults (empty optional fields) are dropped. */
export function messageLinkRefs(provenance: ComposerProvenance | undefined): MessageLinkRef[] {
	const seen = new Set<string>()
	const refs: MessageLinkRef[] = []
	for (const link of provenance?.messageLinks ?? []) {
		if (typeof link?.threadId !== "string" || !link.threadId || link.threadId.length > 200) continue
		if (!Number.isSafeInteger(link.messageIndex) || link.messageIndex < 0) continue
		const toolCallId = link.toolCallId || undefined
		const block = toolCallId === undefined && Number.isSafeInteger(link.block) ? link.block : undefined
		const key = `${link.threadId}:${link.messageIndex}:${toolCallId ?? ""}:${block ?? ""}`
		if (seen.has(key)) continue
		seen.add(key)
		refs.push({
			threadId: link.threadId,
			messageIndex: link.messageIndex,
			...(toolCallId ? { toolCallId } : {}),
			...(block !== undefined ? { block } : {}),
		})
		if (refs.length >= MAX_MESSAGE_LINKS) break
	}
	return refs
}

/** The thread ids a message authorizes: explicit picks only, deduplicated and capped. */
export function authorizedThreadIds(provenance: ComposerProvenance | undefined): Set<string> {
	const ids = (provenance?.authorizedThreadIds ?? []).filter(
		(id) => typeof id === "string" && id.length > 0 && id.length <= 200,
	)
	return new Set(ids.slice(0, MAX_AUTHORIZED_THREADS))
}

/** The option values of the marker's script run, text values and flags merged. */
export function scriptInvocationValues(marker: NonNullable<ComposerProvenance["scriptInvocation"]>): ScriptValues {
	return { ...marker.values, ...marker.flags }
}

/** Drops empty protobuf defaults: undefined when the message carries no explicit authorization. */
export function normalizeProvenance(provenance: ComposerProvenance | undefined): ComposerProvenance | undefined {
	const ids = [...authorizedThreadIds(provenance)]
	const marker = provenance?.scriptInvocation?.name ? provenance.scriptInvocation : undefined
	const messageLinks = messageLinkRefs(provenance)
	if (ids.length === 0 && !marker && messageLinks.length === 0) return undefined
	return { authorizedThreadIds: ids, scriptInvocation: marker, ...(messageLinks.length > 0 ? { messageLinks } : {}) }
}
