import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import type { ThreadModelSelection } from "@shared/model-settings"
import type { Mode } from "@shared/storage/types"
import type { StateManager } from "@/core/storage/StateManager"
import { modelSettingsRolloutEnabled } from "./rollout"

type StateReader = Pick<StateManager, "getGlobalStateKey">

const runsOnModelSettings = (state: StateReader) =>
	modelSettingsRolloutEnabled() && state.getGlobalStateKey("modelSettingsMigration")?.status === "complete"

/**
 * Old settings writers change nothing the runtime reads once the new store is in use. Refusing means a
 * path nobody moved over fails where it can be seen, rather than reporting a change that didn't happen.
 */
export function assertLegacySettingsWrite(state: StateReader, what: string): void {
	if (runsOnModelSettings(state)) throw new Error(`${what} no longer changes which model runs. Use Settings > Models.`)
}

/**
 * What runs in `mode` by the new store, for anything that only needs to know the provider or model.
 * Undefined while the old store is in use. With nothing picked it's empty: the old selection isn't what runs.
 */
export function configuredActiveModel(
	state: StateReader,
	mode: Mode,
	selection?: ThreadModelSelection,
): { providerId?: string; modelId?: string } | undefined {
	if (!runsOnModelSettings(state)) return undefined
	const settings = state.getGlobalStateKey("modelSettings")
	if (!settings) return {}
	const { roles } = settings
	const role = mode === "plan" && roles.ask.enabled ? roles.ask.pick : roles.chat
	const pick = (mode === "plan" ? selection?.ask : selection?.act) ?? role
	const model = settings.models.find((row) => row.id === pick?.modelId)
	const connection = settings.connections.find((c) => c.id === model?.connectionId)
	if (!model || !connection) return {}
	return {
		providerId: toLegacyApiProvider(connection.kind === "provider" ? connection.providerId : "openai"),
		modelId: model.upstreamId,
	}
}
