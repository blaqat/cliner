import type { TaskApiSelection } from "@shared/api-profiles"
import {
	BASE_URL_NEEDED,
	type BackgroundUse,
	BUILTIN_MODEL_VALUES,
	MODEL_ID_NEEDED,
	type ModelMetadata,
	type ModelPick,
	type ModelSettings,
	type ModelSettingsMigration,
	type ModelValues,
	type NextMessageSelection,
	resolveModelValues,
	type ThreadModelSelection,
	ThreadModelSelectionSchema,
} from "@shared/model-settings"
import type { Mode } from "@shared/storage/types"
import { closestOfferedLevel } from "./model-settings/legacy-values"
import { type ConnectionAuthDependencies, prepareModelRequest } from "./model-settings/request-adapter"
import { modelSettingsRolloutEnabled } from "./model-settings/rollout"

const fix = "Open Settings > Models to choose a model and level."
export function captureThreadModelSelection(settings: ModelSettings): ThreadModelSelection {
	return structuredClone({
		version: 1,
		act: settings.roles.chat,
		ask: settings.roles.ask.enabled ? settings.roles.ask.pick : settings.roles.chat,
	})
}
/** The level a migrated thread runs at. A saved effort never stops it, so it moves to the closest one offered. */
function offeredThreadLevel(settings: ModelSettings, modelId: string, levelId: string): string {
	const model = settings.models.find((m) => m.id === modelId)
	if (!model) return levelId
	const connection = settings.connections.find((c) => c.id === model.connectionId)
	const levels = model.overrides.levels ?? connection?.defaults.levels ?? BUILTIN_MODEL_VALUES.levels
	return closestOfferedLevel(levels, levelId)
}
/**
 * Missing historical references remain explicit unavailable picks. A mode the thread never recorded falls back
 * to the current selection at its recorded effort, as legacy did, when `settings` is given.
 */
export function migrateThreadModelSelection(
	selection: TaskApiSelection,
	journal: ModelSettingsMigration,
	settings?: ModelSettings,
): ThreadModelSelection {
	const current = settings && captureThreadModelSelection(settings)
	const level = (effort: string) => (effort === "none" ? "default" : effort)
	const pick = (
		id: string | undefined,
		effort: string | undefined,
		fallback: ModelPick | null | undefined,
	): ModelPick | null => {
		if (!id) {
			if (!fallback || !settings) return fallback ?? null
			return effort ? { ...fallback, levelId: offeredThreadLevel(settings, fallback.modelId, level(effort)) } : fallback
		}
		const saved = journal.profilePicks[id]
		const modelId = saved?.modelId ?? journal.configurationModels[id] ?? `missing:${id}`
		const levelId = effort ? level(effort) : (saved?.levelId ?? "default")
		return { modelId, levelId: settings ? offeredThreadLevel(settings, modelId, levelId) : levelId }
	}
	return {
		version: 1,
		ask: pick(selection.askProfileId, selection.planModeReasoningEffort, current?.ask),
		act: pick(selection.actProfileId, selection.actModeReasoningEffort, current?.act),
	}
}
export function resolveThreadPick(selection: ThreadModelSelection, mode: Mode, next?: NextMessageSelection): ModelPick | null {
	ThreadModelSelectionSchema.parse(selection)
	return structuredClone(next?.mode === mode ? next.pick : mode === "plan" ? selection.ask : selection.act)
}
export function resolveBackgroundPick(settings: ModelSettings, use: BackgroundUse, oneCall?: ModelPick): ModelPick | null {
	if (use === "titles" && !settings.roles.background.titlesEnabled) return null
	const pick = oneCall ?? settings.roles.background.overrides[use] ?? settings.roles.background.pick
	if (!pick) throw new Error(`No model selected for Background text (${use}). ${fix}`)
	return structuredClone(pick)
}
export function resolveConfiguredPick(
	settings: ModelSettings,
	pick: ModelPick | null,
	metadata?: ModelMetadata,
	managed: Partial<ModelValues> = {},
) {
	if (!pick) throw new Error(`No model selected. ${fix}`)
	const model = settings.models.find((m) => m.id === pick.modelId)
	if (!model) throw new Error(`The model picked here was removed. ${fix}`)
	const connection = settings.connections.find((c) => c.id === model.connectionId)
	if (!connection) throw new Error(`The connection for '${model.name || model.upstreamId}' was removed. ${fix}`)
	if (model.kind === "non-chat") throw new Error(`Saved model does not support chat. ${fix}`)
	if (model.upstreamId === MODEL_ID_NEEDED) throw new Error(`This model has no model ID. Add it in Settings > Models.`)
	if (connection.baseUrl === BASE_URL_NEEDED)
		throw new Error(`This connection's base URL isn't valid. Fix it in Settings > Models.`)
	const fields = resolveModelValues(
		model.overrides,
		metadata?.modelId === model.id ? metadata.values : undefined,
		connection.defaults,
		managed,
	)
	const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])) as ModelValues
	const level = values.levels.find((l) => l.id === pick.levelId)
	if (!level) throw new Error(`Saved level '${pick.levelId}' is not offered by '${model.name || model.upstreamId}'. ${fix}`)
	if (values.reasoning !== "yes" && level.request.kind !== "default")
		throw new Error(`Reasoning is unknown or unsupported for this model. ${fix}`)
	return structuredClone({ model, connection, values, levelId: pick.levelId })
}
/** The only rollout switch for request admission. Off never reads the new stores or credentials. */
export async function resolveModelSettingsRequest<T>(input: {
	enabled?: boolean
	legacy: () => T | Promise<T>
	settings: () => ModelSettings
	pick: (settings: ModelSettings) => ModelPick | null
	request: Omit<Parameters<typeof prepareModelRequest>[0], "connection" | "model" | "values" | "levelId" | "requestTimeoutMs">
	dependencies: ConnectionAuthDependencies
}) {
	if (!modelSettingsRolloutEnabled(input.enabled)) return input.legacy()
	const settings = structuredClone(input.settings())
	return prepareModelRequest(
		{
			...input.request,
			...resolveConfiguredPick(settings, input.pick(settings)),
			requestTimeoutMs: settings.requestTimeoutMs,
		},
		input.dependencies,
	)
}
/** Contract boundary for Phase 3. No credentials are included in policy descriptions. */
export interface SubagentModelSettingsResolver {
	resolve(pick: ModelPick): Promise<Awaited<ReturnType<typeof prepareModelRequest>>>
	snapshot: Readonly<Pick<ModelSettings, "subagents" | "roles">>
	parent: ModelPick
}

export const transientAdmission = Symbol("configuredModelAdmission")

/** Transient overrides are scoped to a thread and mode, and survive failed admission. */
export class NextMessageModelSelections {
	private readonly threads = new Map<string, Partial<Record<Mode, ModelPick>>>()
	set(threadId: string, mode: Mode, pick: ModelPick): void {
		const modes = this.threads.get(threadId) ?? {}
		modes[mode] = structuredClone(pick)
		this.threads.set(threadId, modes)
	}
	snapshot(): Array<{ id: string; modelSelectionV1: unknown }> {
		return [...this.threads].map(([id, modes]) => ({
			id: `${id || "home"}:next-message`,
			modelSelectionV1: structuredClone(modes),
		}))
	}
	peek(threadId: string, mode: Mode): ModelPick | undefined {
		const pick = this.threads.get(threadId)?.[mode]
		return pick ? structuredClone(pick) : undefined
	}
	clear(threadId: string, mode: Mode): void {
		const modes = this.threads.get(threadId)
		if (!modes) return
		delete modes[mode]
		if (!Object.keys(modes).length) this.threads.delete(threadId)
	}
	move(from: string, to: string): void {
		const modes = this.threads.get(from)
		if (!modes) return
		this.threads.delete(from)
		this.threads.set(to, modes)
	}
	/** Capture identity before async work so a newer choice cannot be consumed. */
	admission(threadId: string, mode: Mode): { pick: ModelPick; commit: () => void } | undefined {
		const modes = this.threads.get(threadId)
		const pending = modes?.[mode]
		if (!pending) return undefined
		return {
			pick: structuredClone(pending),
			commit: () => {
				const owner = [...this.threads].find(([, value]) => value === modes)?.[0]
				if (owner === undefined || modes?.[mode] !== pending) return
				delete modes[mode]
				if (!Object.keys(modes).length) this.threads.delete(owner)
			},
		}
	}
	async admit<T>(
		threadId: string,
		mode: Mode,
		selection: ThreadModelSelection,
		launch: (pick: ModelPick | null) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const modes = this.threads.get(threadId)
		const pending = modes?.[mode]
		signal?.throwIfAborted()
		const result = await launch(resolveThreadPick(selection, mode, pending ? { mode, pick: pending } : undefined))
		signal?.throwIfAborted()
		if (pending && modes?.[mode] === pending) {
			delete modes[mode]
			if (Object.keys(modes).length === 0) this.threads.delete(threadId)
		}
		return result
	}
}
