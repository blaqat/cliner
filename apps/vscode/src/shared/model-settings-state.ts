import type { ModelSettings, resolveModelValues } from "./model-settings"

/** Public state contains references/configured flags, never credential values. */
export type ModelSettingsState = {
	settings: ModelSettings
	configuredSecrets: Record<string, boolean>
	effective: Record<string, ReturnType<typeof resolveModelValues>>
	availability: Record<string, { available: boolean; reason?: string }>
	planning: Record<string, { contextWindowKnown: boolean; planningContextWindow: number }>
	managed: string[]
	migration: { status: "disabled" | "pending" | "complete" | "failed"; retryable: boolean }
}
