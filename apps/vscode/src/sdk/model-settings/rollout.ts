/** Flip only when Phase 8 retires the legacy settings writers. Never a user preference. */
export const MODEL_SETTINGS_ROLLOUT_ENABLED = true

export function modelSettingsRolloutEnabled(override?: boolean): boolean {
	return override ?? MODEL_SETTINGS_ROLLOUT_ENABLED
}
