/** A saved value migration changed or could not keep. Names what, never the value. */
export type ModelSettingsMigrationIssue = {
	kind: "normalized" | "dropped"
	field: string
	/** The saved configuration or file it came from, by name. */
	source: string
	modelId?: string
	connectionId?: string
}

/** Published with webview state whether or not the journal is complete, so a failure can be retried. */
export type ModelSettingsMigrationStatus = {
	status: "disabled" | "pending" | "complete" | "failed"
	retryable: boolean
	/** Redacted: a fixed description, never an error message from a store or a saved value. */
	cause?: string
	issues?: ModelSettingsMigrationIssue[]
}
