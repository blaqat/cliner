import type { ModelSettingsState } from "@shared/model-settings-state"
import { settingsTargetFromHost } from "@/components/settings/settingsTargets"
import type { SelectorLevel, SelectorPick, SelectorRow } from "./ModelSelector"

/** Every selector's level column starts from these, so a level a model lacks shows greyed. */
export const STANDARD_LEVELS: SelectorLevel[] = [
	{ id: "default", label: "Default", detail: "Provider default" },
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
	{ id: "xhigh", label: "XHigh" },
]

/** The level a no-reasoning model saves: the host accepts only this one for it. */
const NO_LEVEL_ID = "default"

/** Imported levels can be plain tokens ("xhigh"); a label someone typed stays as it is. */
function levelLabel(label: string): string {
	if (label !== label.toLowerCase()) return label
	return label === "xhigh" ? "XHigh" : label.charAt(0).toUpperCase() + label.slice(1)
}

/** A trigger's label for a level, short enough for a narrow row: "Med", not "Medium". */
export const shortLevelLabel = (label: string) => (label === "Medium" ? "Med" : label)

/**
 * The selector's rows and level column from the published model settings: every configured chat or
 * unknown model, under its connection, in connection order. No favorites or star filter.
 */
export function selectorDataFromModelSettings(state: ModelSettingsState): { rows: SelectorRow[]; ladder: SelectorLevel[] } {
	const { connections, models } = state.settings
	const connectionName = (id: string) => {
		const connection = connections.find((candidate) => candidate.id === id)
		if (!connection) return "Connection"
		return connection.name || (connection.kind === "provider" ? connection.providerId : connection.baseUrl) || "Connection"
	}
	const listed = connections.flatMap((connection) =>
		models.filter((model) => model.connectionId === connection.id && model.kind !== "non-chat"),
	)
	const displayName = (model: (typeof listed)[number]) => model.name || model.upstreamId
	const count = (values: string[], value: string) => values.filter((candidate) => candidate === value).length
	const names = listed.map(displayName)
	const named = listed.map((model) => `${displayName(model)} · ${connectionName(model.connectionId)}`)

	const rows = listed.map((model, i): SelectorRow => {
		const name = displayName(model)
		const connection = connectionName(model.connectionId)
		const effective = state.effective[model.id]
		const availability = state.availability[model.id]
		// Two rows sharing a name show their connection; still the same, the upstream id and a short id.
		const label =
			count(names, name) === 1
				? name
				: count(named, named[i]) === 1
					? named[i]
					: `${named[i]} · ${model.upstreamId} · ${model.id.slice(0, 6)}`
		const reasoning = effective?.reasoning.value ?? "unknown"
		return {
			id: model.id,
			label,
			detail: `${model.upstreamId} · ${connection}`,
			group: connection,
			// Under its connection's heading, a name shared with another connection needs no suffix.
			groupedLabel: count(named, named[i]) === 1 ? name : undefined,
			levels:
				reasoning === "yes"
					? (effective?.levels.value ?? []).map((level) => ({
							id: level.id,
							label: levelLabel(level.label),
							detail: level.id === "default" ? "Provider default" : undefined,
						}))
					: null,
			noLevelsReason:
				reasoning === "no"
					? "This model has no reasoning control"
					: `Reasoning is unknown for ${name}, so no level is sent`,
			noLevelsNote: reasoning === "unknown" ? `Reasoning is unknown for ${name}, so no level is sent.` : undefined,
			noLevelId: NO_LEVEL_ID,
			disabledReason:
				availability && !availability.available
					? `${availability.reason ?? "This model can't run"}`.replace(/\.?$/, ".")
					: undefined,
			fixTarget: availability?.target && settingsTargetFromHost(availability.target),
			levelsTarget: `model:${model.id}:levels`,
		}
	})

	// The standard levels, then any others in the order the models rank them.
	const custom = listed
		.flatMap((model) => state.effective[model.id]?.levels.value ?? [])
		.filter((level) => !STANDARD_LEVELS.some((standard) => standard.id === level.id))
		.sort((a, b) => a.rank - b.rank)
		.map((level) => ({ id: level.id, label: levelLabel(level.label) }))
	const ladder = [...STANDARD_LEVELS, ...custom.filter((level, i) => custom.findIndex((other) => other.id === level.id) === i)]
	return { rows, ladder }
}

/** "Same as the thread" and its level list, for the roles that allow it. Background text doesn't. */
export function sameAsThreadRow(ladder: SelectorLevel[]): SelectorRow {
	return {
		id: "thread",
		label: "Same as the thread",
		levels: [{ id: "inherit", label: "Thread's level" }, ...ladder],
		defaultLevelId: "inherit",
	}
}

/** What a trigger shows for a pick: "GPT-6 Sol" and "Med", or why there's nothing to show. */
export function describePick(
	rows: SelectorRow[],
	pick: SelectorPick | null,
): { model: string; level?: string; levelOffered: boolean; picked: boolean } {
	const row = rows.find((candidate) => candidate.id === pick?.rowId)
	if (!row || !pick) return { model: rows.length ? "Pick a model" : "No models yet", levelOffered: true, picked: false }
	if (!row.levels) return { model: row.label, levelOffered: true, picked: true }
	if (pick.levelId === "inherit") return { model: row.label, levelOffered: true, picked: true }
	const level = row.levels.find((candidate) => candidate.id === pick.levelId)
	return {
		model: row.label,
		level: shortLevelLabel(level?.label ?? levelLabel(pick.levelId)),
		levelOffered: !!level,
		picked: true,
	}
}

export const samePick = (a: SelectorPick | null, b: SelectorPick | null) => a?.rowId === b?.rowId && a?.levelId === b?.levelId
