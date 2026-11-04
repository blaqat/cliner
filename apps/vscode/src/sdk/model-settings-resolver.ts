import type { TaskApiSelection } from "@shared/api-profiles"
import {
	type BackgroundUse,
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
/** Missing historical references remain explicit unavailable picks. Never borrow today's default. */
export function migrateThreadModelSelection(selection: TaskApiSelection, journal: ModelSettingsMigration): ThreadModelSelection {
	const pick = (id: string | undefined, effort: string | undefined): ModelPick | null => {
		if (!id) return null
		const saved = journal.profilePicks[id]
		return {
			modelId: saved?.modelId ?? journal.configurationModels[id] ?? `missing:${id}`,
			levelId: effort ? (effort === "none" ? "default" : effort) : (saved?.levelId ?? "default"),
		}
	}
	return {
		version: 1,
		ask: pick(selection.askProfileId, selection.planModeReasoningEffort),
		act: pick(selection.actProfileId, selection.actModeReasoningEffort),
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
	if (!model) throw new Error(`Saved model '${pick.modelId}' is unavailable. ${fix}`)
	const connection = settings.connections.find((c) => c.id === model.connectionId)
	if (!connection) throw new Error(`Saved connection '${model.connectionId}' is unavailable. ${fix}`)
	if (model.kind === "non-chat") throw new Error(`Saved model does not support chat. ${fix}`)
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
