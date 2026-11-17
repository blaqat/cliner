import type { ModelSettings, resolveModelValues } from "./model-settings"
import type { ModelSettingsMigrationStatus } from "./model-settings-migration-status"

/** Where the control that fixes an unusable pick lives. */
export type ModelSettingsFixTarget = {
	page: "models"
	modelId?: string
	field?: string
	connectionId?: string
	role?: string
}

/** Public state contains references/configured flags, never credential values. */
export type ModelSettingsState = {
	settings: ModelSettings
	configuredSecrets: Record<string, boolean>
	effective: Record<string, ReturnType<typeof resolveModelValues>>
	availability: Record<string, { available: boolean; reason?: string; target?: ModelSettingsFixTarget }>
	planning: Record<string, { contextWindowKnown: boolean; planningContextWindow: number }>
	managed: string[]
	migration: ModelSettingsMigrationStatus
}
