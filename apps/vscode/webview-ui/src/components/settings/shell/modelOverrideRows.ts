import type { ModelRow, ModelValues } from "@shared/model-settings"
import { modelSettingsClient } from "../models/modelSettingsClient"
import { modelName, overridesShared, withoutOverride } from "../models/modelsView"
import type { PreferenceRow, SettingsRowContext } from "./settingsRegistry"

/** The fields the model form tags Changed + Reset, by the name it shows them under. */
const FIELD_LABELS: Partial<Record<keyof ModelValues, string>> = {
	contextWindow: "Context window",
	maxOutputTokens: "Max output tokens",
	maxInputTokens: "Max input tokens",
	images: "Images",
	tools: "Tools",
	reasoning: "Reasoning",
	levels: "Levels",
	temperature: "Temperature",
	verbosity: "Verbosity",
	thinkingBudgetTokens: "Thinking budget",
	free: "Free",
	inputPrice: "Input price",
	outputPrice: "Output price",
	streaming: "Streaming",
	promptCache: "Prompt cache",
	cacheReadPrice: "Cache read price",
	cacheWritePrice: "Cache write price",
	files: "Files",
	systemRole: "System role",
	apiFormat: "API type",
}

const resetOverride = async (modelId: string, key: keyof ModelValues) => {
	const latest = await modelSettingsClient.get()
	const current = latest.settings.models.find((row: ModelRow) => row.id === modelId)
	if (current) {
		await modelSettingsClient.saveModels(latest.settings.revision, [withoutOverride(current, key)])
	}
}

/**
 * One Changed row per value a model sets over its connection's shared default, the same ones its form
 * tags in place. They come from the store, since models aren't a fixed list of rows, and a value the
 * organization manages isn't the person's own change.
 */
export const modelOverrideRows = (ctx: SettingsRowContext): PreferenceRow[] => {
	const store = ctx.state.modelSettings
	if (!store) {
		return []
	}
	return store.settings.models.flatMap((model) => {
		const connection = store.settings.connections.find((candidate) => candidate.id === model.connectionId)
		if (!connection) {
			return []
		}
		return (Object.keys(FIELD_LABELS) as (keyof ModelValues)[])
			.filter((key) => overridesShared(model, connection, key) && store.effective[model.id]?.[key]?.source !== "managed")
			.map(
				(key): PreferenceRow => ({
					id: `model:${model.id}:${key}`,
					page: "models",
					kind: "preference",
					label: `${modelName(model)}: ${FIELD_LABELS[key]}`,
					defaultValue: () => connection.defaults[key],
					read: () => model.overrides[key],
					write: () => undefined,
					isOverride: () => true,
					reset: () => resetOverride(model.id, key),
					format: (value) =>
						Array.isArray(value)
							? `${value.length} levels`
							: value === null || value === undefined
								? "Not set"
								: String(value),
				}),
			)
	})
}
