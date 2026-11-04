import { createHandler } from "@cline/llms"
import type { BackgroundUse, ModelPick } from "@shared/model-settings"
import type { StateManager } from "@/core/storage/StateManager"
import { resolveBackgroundPick } from "../model-settings-resolver"
import { modelAuthDependencies } from "./auth-dependencies"
import { modelSettingsRolloutEnabled } from "./rollout"
import { configuredProviderConfig } from "./runtime-config"

export function useModelSettings(state: Pick<StateManager, "getGlobalStateKey">): boolean {
	return modelSettingsRolloutEnabled() && state.getGlobalStateKey("modelSettingsMigration")?.status === "complete"
}
export async function backgroundHandler(
	state: Pick<StateManager, "getGlobalStateKey"> & Partial<Pick<StateManager, "connectionSecrets">>,
	use: BackgroundUse,
	oneCall?: ModelPick,
) {
	const settings = structuredClone(state.getGlobalStateKey("modelSettings")!)
	const pick = resolveBackgroundPick(settings, use, oneCall)
	if (!pick) return undefined
	if (!state.connectionSecrets) throw new Error("Connection keychain is unavailable")
	return createHandler(await configuredProviderConfig(settings, pick, modelAuthDependencies(state)))
}
