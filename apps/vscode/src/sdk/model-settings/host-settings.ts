import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import {
	ConnectionSchema,
	createDefaultModelSettings,
	type ModelSettings,
	ModelSettingsSchema,
	resolveModelValues,
} from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import type { StateManager } from "@/core/storage/StateManager"
import { resolveConfiguredPick } from "../model-settings-resolver"

const snapshots = new WeakMap<StateManager, { key: string; value: Promise<ModelSettingsState> }>()
export function readModelSettingsState(state: StateManager): Promise<ModelSettingsState> {
	const key = JSON.stringify([
		state.getGlobalStateKey("modelSettings")?.revision ?? 0,
		state.getRemoteConfigSettings(),
		state.getModelSettingsMigrationStatus(),
	])
	const cached = snapshots.get(state)
	if (cached?.key === key) return cached.value
	const value = buildModelSettingsState(state)
	snapshots.set(state, { key, value })
	void value.catch(() => {
		if (snapshots.get(state)?.value === value) snapshots.delete(state)
	})
	return value
}
async function buildModelSettingsState(state: StateManager): Promise<ModelSettingsState> {
	const settings = ModelSettingsSchema.parse(state.getGlobalStateKey("modelSettings") ?? createDefaultModelSettings())
	const configuredSecrets: Record<string, boolean> = {}
	for (const c of settings.connections)
		for (const ref of connectionSecretRefs(c)) configuredSecrets[ref] = !!(await state.connectionSecrets?.get(ref))
	const effective: ModelSettingsState["effective"] = {}
	const planning: ModelSettingsState["planning"] = {}
	const availability: ModelSettingsState["availability"] = {}
	for (const row of settings.models) {
		const connection = settings.connections.find((c) => c.id === row.connectionId)!
		effective[row.id] = resolveModelValues(row.overrides, undefined, connection.defaults)
		const contextWindow = effective[row.id].contextWindow.value
		planning[row.id] = { contextWindowKnown: contextWindow !== null, planningContextWindow: contextWindow ?? 128000 }
		let reason: string | undefined
		try {
			resolveConfiguredPick(settings, { modelId: row.id, levelId: "default" })
			if (connectionSecretRefs(connection).some((ref) => !configuredSecrets[ref]))
				reason = "Connection credentials are missing"
			if (connection.auth.kind === "environment" && !process.env[connection.auth.variable])
				reason = "Connection environment variable is empty"
		} catch (error) {
			reason = error instanceof Error ? error.message : "Model is unavailable"
		}
		availability[row.id] = { available: !reason, ...(reason ? { reason } : {}) }
	}
	for (const [name, pick] of Object.entries({
		"role.chat": settings.roles.chat,
		"role.ask": settings.roles.ask.enabled ? settings.roles.ask.pick : settings.roles.chat,
		"background.generate": settings.roles.background.overrides.generate ?? settings.roles.background.pick,
		"background.commitMessages": settings.roles.background.overrides.commitMessages ?? settings.roles.background.pick,
		"background.titles": settings.roles.background.overrides.titles ?? settings.roles.background.pick,
	})) {
		try {
			resolveConfiguredPick(settings, pick)
			availability[name] = availability[pick!.modelId]
		} catch (error) {
			availability[name] = {
				available: false,
				reason: error instanceof Error ? error.message : "Choose a model in Settings > Models",
			}
		}
	}
	// Legacy metadata is a host-only compatibility carrier, not an editable JSON bag.
	for (const model of settings.models) delete model.legacyMetadata
	return {
		settings,
		planning,
		configuredSecrets,
		effective,
		availability,
		managed: Object.keys(state.getRemoteConfigSettings()),
		migration: state.getModelSettingsMigrationStatus(),
	}
}

export function connectionSecretRefs(connection: ModelSettings["connections"][number]): string[] {
	return [
		...(connection.auth.kind === "keychain" ? [connection.auth.secretRef] : []),
		...connection.headers.flatMap((h) => (h.storage === "secret" ? [h.secretRef] : [])),
		...Object.values(connection.kind === "provider" ? connection.secretRefs : {}),
	]
}

/** A connection cannot read or mutate a different connection's keychain namespace. */
export function validateConnectionSecretRefs(connection: ModelSettings["connections"][number]): void {
	ConnectionSchema.parse(connection)
	const prefix = `settings:v1:connection:${connection.id}:`
	if (connectionSecretRefs(connection).some((ref) => !ref.startsWith(prefix) || ref.length === prefix.length))
		throw new Error("Invalid connection secret reference")
}

/** Existing remote provider controls remain authoritative at the host boundary. */
export function assertModelSettingsUnlocked(state: StateManager, next: ModelSettings): void {
	const managed = state.getRemoteConfigSettings()
	const providers = managed.remoteConfiguredProviders ?? []
	for (const connection of next.connections) {
		const provider = connection.kind === "provider" ? connection.providerId : "openai"
		if (providers.length && !providers.includes(provider as never))
			throw new Error("This provider is not allowed by your organization")
	}

	const before = state.getGlobalStateKey("modelSettings") ?? createDefaultModelSettings()
	const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
	const policyLocks = {
		subagentsEnabled: [before.subagents.enabled, next.subagents.enabled],
		subagentsMaxConcurrent: [before.subagents.maxConcurrent, next.subagents.maxConcurrent],
		subagentsAllowWrite: [before.subagents.access.write, next.subagents.access.write],
		subagentsAllowCommands: [before.subagents.access.commands, next.subagents.access.commands],
		subagentsAllowWeb: [before.subagents.access.web, next.subagents.access.web],
		subagentsAllowMcp: [before.subagents.access.mcp, next.subagents.access.mcp],
	}
	for (const [key, [previous, value]] of Object.entries(policyLocks))
		if (managed[key as keyof typeof managed] !== undefined && changed(previous, value))
			throw new Error(`Setting "${key}" is managed by your organization`)
	for (const connection of next.connections) {
		const previous = before.connections.find((c) => c.id === connection.id)
		const options = connection.kind === "provider" ? connection.options : {}
		const previousOptions = previous?.kind === "provider" ? previous.options : {}
		for (const [key, value] of Object.entries(options))
			if (
				managed[key as keyof typeof managed] !== undefined &&
				changed(previousOptions[key as keyof typeof previousOptions], value)
			)
				throw new Error(`Setting "${key}" is managed by your organization`)
		if (
			connection.kind === "openai-compatible" &&
			managed.openAiBaseUrl !== undefined &&
			changed(previous?.baseUrl, connection.baseUrl)
		)
			throw new Error("Connection URL is managed by your organization")
	}
	for (const [mode, pick] of [
		["act", next.roles.chat],
		["plan", next.roles.ask.enabled ? next.roles.ask.pick : next.roles.chat],
	] as const) {
		if (!pick) continue
		const model = next.models.find((m) => m.id === pick.modelId)
		const connection = next.connections.find((c) => c.id === model?.connectionId)
		if (!model || !connection) continue
		const provider = toLegacyApiProvider(connection.kind === "provider" ? connection.providerId : "openai")
		const key = getProviderModelIdKey(provider, mode)
		const lockedId = managed[key]
		if (typeof lockedId === "string" && model.upstreamId !== lockedId)
			throw new Error("This model is managed by your organization")
	}
}

export function modelDependencies(state: StateManager, settings: ModelSettings, ids: string[]) {
	const targets = new Set(ids)
	const dependencies: string[] = []
	const visit = (value: unknown, path: string): void => {
		if (!value || typeof value !== "object") return
		if ("modelId" in value && targets.has(String(value.modelId))) dependencies.push(path)
		for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`)
	}
	visit(settings.roles, "roles")
	visit(settings.subagents.allowed, "subagents.allowed")
	for (const item of state.getGlobalStateKey("taskHistory") ?? []) visit(item.modelSelectionV1, `thread:${item.id}`)
	return dependencies
}
