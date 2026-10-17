import type { OpenaiReasoningEffort } from "./storage/types"

/**
 * A named profile: a saved model configuration (Settings › Models) run at a
 * chosen reasoning effort. Thread defaults, subagents, walkthrough Generate
 * and thread titles pick profiles; the composer and per-chat selections keep
 * working with configurations directly.
 */
export interface ModelProfile {
	id: string
	name: string
	/** Id of an `apiConfigProfiles` entry. */
	configurationId: string
	/** Unset is the provider default ("none"). */
	reasoningEffort?: OpenaiReasoningEffort
}
