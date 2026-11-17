import { createHandler } from "@cline/llms"
import type { BackgroundUse, ModelPick } from "@shared/model-settings"
import type { StateManager } from "@/core/storage/StateManager"
import { resolveBackgroundPick } from "../model-settings-resolver"
import { modelAuthDependencies } from "./auth-dependencies"
import { modelSettingsRolloutEnabled } from "./rollout"
import { configuredProviderConfig, requestPolicyGuard } from "./runtime-config"

export function useModelSettings(state: Pick<StateManager, "getGlobalStateKey">): boolean {
	return modelSettingsRolloutEnabled() && state.getGlobalStateKey("modelSettingsMigration")?.status === "complete"
}
const activePicks = new WeakMap<object, Map<symbol, { id: string; modelSelectionV1: ModelPick }>>()
export function backgroundSelectionDependencies(state: object) {
	return [...(activePicks.get(state)?.values() ?? [])]
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
	const config = await configuredProviderConfig(settings, pick, modelAuthDependencies(state as StateManager), {
		state: state as StateManager,
	})
	const handler = createHandler(config)
	const createMessage = handler.createMessage.bind(handler)
	handler.createMessage = async function* (...args) {
		const token = Symbol(use)
		const picks = activePicks.get(state) ?? new Map()
		picks.set(token, { id: `background:${use}`, modelSelectionV1: pick })
		activePicks.set(state, picks)
		try {
			await config[requestPolicyGuard]?.()
			yield* createMessage(...args)
		} finally {
			picks.delete(token)
		}
	}
	return handler
}
