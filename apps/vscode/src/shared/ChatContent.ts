import type { ComposerProvenance } from "./composer-provenance"

export interface ChatContent {
	message?: string
	images?: string[]
	files?: string[]
	/** What the user explicitly picked or ran in the composer for `message`. */
	provenance?: ComposerProvenance
}
