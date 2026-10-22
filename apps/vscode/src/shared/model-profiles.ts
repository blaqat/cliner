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

/**
 * Configuration-based references earlier releases wrote and may write again
 * after a downgrade (all ids are saved-configuration ids).
 */
export interface LegacyFeatureRefs {
	subagentDefaultProfileId?: string
	subagentAllowedProfileIds?: string[]
	walkthroughGenerateProfileId?: string
	threadTitlesProfileId?: string
	subagentReasoningEffort?: string
}

/** What the profile migration last reconciled against. */
export interface ProfilesMigrationState {
	version: number
	legacy: LegacyFeatureRefs
}

/**
 * The Ask/Act selection (configuration + effort per mode) this release last
 * persisted. Older releases don't update it, so a live selection that differs
 * from it was chosen in an older release.
 */
export interface ThreadSelectionStamp {
	askProfileId?: string
	actProfileId?: string
	planModeReasoningEffort?: string
	actModeReasoningEffort?: string
}
