import type { ExtensionState } from "@shared/ExtensionMessage"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import type { Connection, ModelPick, ModelRow } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import type { Mode } from "@shared/storage/types"

export interface SelectedConfiguredModel {
	pick: ModelPick
	model: ModelRow
	connection: Connection
	/** Today's provider spelling; a compatible connection reads as "openai". */
	provider: string
	effective: ModelSettingsState["effective"][string] | undefined
}

type ComposerState = Pick<ExtensionState, "modelSettings" | "composerApiSelection">

/**
 * The configured model the composer has selected for `mode`: this chat's pick, else the role's default.
 * Undefined when nothing usable is picked, or while the host doesn't publish the new store.
 */
export function selectedConfiguredModel(state: ComposerState, mode: Mode): SelectedConfiguredModel | undefined {
	const published = state.modelSettings
	if (!published) return undefined
	const { roles } = published.settings
	const role = mode === "plan" && roles.ask.enabled ? roles.ask.pick : roles.chat
	const pick = state.composerApiSelection?.modelSelectionV1?.[mode === "plan" ? "ask" : "act"] ?? role
	const model = published.settings.models.find((row) => row.id === pick?.modelId)
	const connection = published.settings.connections.find((row) => row.id === model?.connectionId)
	if (!pick || !model || !connection) return undefined
	return {
		pick,
		model,
		connection,
		provider: toLegacyApiProvider(connection.kind === "provider" ? connection.providerId : "openai"),
		effective: published.effective[model.id],
	}
}

/** Whether the composer's effort control has anything to choose between. */
export const selectedModelOffersLevels = (state: ComposerState, mode: Mode) =>
	(selectedConfiguredModel(state, mode)?.effective?.levels.value.length ?? 0) > 1
