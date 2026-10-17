import type { ScriptValues } from "./scripts"

/**
 * What the user explicitly did in the composer for one message. The host
 * authorizes only what is listed here; it never infers authorization from
 * message text, which can also hold quote chips, "Add to Cline" insertions,
 * restored drafts and expanded notes. Structurally matches the proto message
 * of the same name.
 */
export interface ComposerProvenance {
	/** Thread ids picked from the `thread:` mention menu whose token is still in the text. */
	authorizedThreadIds?: readonly string[]
	/** The saved script the user typed or picked and sent through the script helper. */
	scriptInvocation?: {
		name: string
		values?: Readonly<Record<string, string>>
		flags?: Readonly<Record<string, boolean>>
	}
}

const MAX_AUTHORIZED_THREADS = 50

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
	if (ids.length === 0 && !marker) return undefined
	return { authorizedThreadIds: ids, scriptInvocation: marker }
}
