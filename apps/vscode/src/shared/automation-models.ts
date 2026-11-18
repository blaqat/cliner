/**
 * Automation files name models the way people read them ("Opus 5.5", level "high"), not by the configured
 * row's id, so a file still means something on another machine. These turn a name into a pick against the
 * user's model settings. Shared by the host (starting a thread) and the start form (what will run, prices).
 */
import { effectiveThreadPick, type ModelPick, type ModelRow } from "./model-settings"
import type { ModelSettingsState } from "./model-settings-state"

export type ResolvedAutomationModel =
	| {
			ok: true
			pick: ModelPick
			/** "Opus 5.5". */
			label: string
			/** "High"; absent for a model with no level control. */
			levelLabel?: string
			/** True when the step names no model and runs on the default for its mode. */
			isDefault: boolean
			/** Dollars per million tokens, when the model has prices. */
			inputPrice: number | null
			outputPrice: number | null
	  }
	| { ok: false; reason: string }

type State = Pick<ModelSettingsState, "settings" | "effective" | "availability">

const modelName = (row: ModelRow) => row.name || row.upstreamId

/** The configured chat model a file's name points at: its name, upstream id or row id, ignoring case. */
export function findAutomationModel(state: State, name: string): ModelRow | undefined {
	const wanted = name.trim().toLowerCase()
	if (!wanted) return undefined
	const rows = state.settings.models.filter((row) => row.kind !== "non-chat")
	return (
		rows.find((row) => row.id === name) ??
		rows.find((row) => modelName(row).toLowerCase() === wanted) ??
		rows.find((row) => row.upstreamId.toLowerCase() === wanted)
	)
}

/** The name an automation file stores for a configured model. */
export function automationModelName(row: ModelRow): string {
	return modelName(row)
}

function capitalize(label: string): string {
	return label === label.toLowerCase() ? label.charAt(0).toUpperCase() + label.slice(1) : label
}

/** A step's model and level as a pick that can run, or the reason it can't (with where to fix it). */
export function resolveAutomationModel(state: State, model: string, level: string, mode: "ask" | "act"): ResolvedAutomationModel {
	const internalMode = mode === "ask" ? "plan" : "act"
	let row: ModelRow | undefined
	let levelId = level.trim()
	const isDefault = !model.trim()
	if (isDefault) {
		const pick = effectiveThreadPick(state.settings, null, internalMode)
		if (!pick) return { ok: false, reason: "No default model is set. Pick one in Settings › Models." }
		row = state.settings.models.find((candidate) => candidate.id === pick.modelId)
		levelId ||= pick.levelId
	} else {
		row = findAutomationModel(state, model)
		if (!row) return { ok: false, reason: `${model} isn't set up. Add it in Settings › Models, or pick another model.` }
	}
	if (!row) return { ok: false, reason: "No default model is set. Pick one in Settings › Models." }
	const availability = state.availability[row.id]
	if (availability && !availability.available)
		return { ok: false, reason: `${modelName(row)}: ${availability.reason ?? "it can't run right now"}`.replace(/\.?$/, ".") }
	const effective = state.effective[row.id]
	const levels = effective?.reasoning.value === "yes" ? [...(effective.levels.value ?? [])].sort((a, b) => a.rank - b.rank) : []
	let levelLabel: string | undefined
	if (levels.length === 0) {
		levelId = "default"
	} else {
		const wanted = levelId.toLowerCase()
		const found = wanted
			? levels.find((candidate) => candidate.id.toLowerCase() === wanted || candidate.label.toLowerCase() === wanted)
			: (levels.find((candidate) => candidate.id === "medium") ??
				levels.find((candidate) => candidate.id === "default") ??
				levels[0])
		if (!found) return { ok: false, reason: `${modelName(row)} has no level "${levelId}". Pick another level.` }
		levelId = found.id
		levelLabel = capitalize(found.label)
	}
	return {
		ok: true,
		pick: { modelId: row.id, levelId },
		label: modelName(row),
		levelLabel,
		isDefault,
		inputPrice: effective?.inputPrice.value ?? null,
		outputPrice: effective?.outputPrice.value ?? null,
	}
}
