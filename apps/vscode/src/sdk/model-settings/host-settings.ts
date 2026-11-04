import { createGateway } from "@cline/llms"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import {
	ConnectionSchema,
	createDefaultModelSettings,
	type ModelSettings,
	type ModelValues,
	type ModelRow,
	ModelSettingsSchema,
	resolveModelValues,
} from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import type { StateManager } from "@/core/storage/StateManager"
import { resolveConfiguredPick } from "../model-settings-resolver"

const detectedMetadata = new WeakMap<StateManager, Map<string, { revision: number; values: Partial<ModelValues> }>>()
/** Detection suggestions are metadata, scoped to the settings revision that produced them. */
export function rememberDetectedModelMetadata(
	state: StateManager,
	modelId: string,
	revision: number,
	values: Partial<ModelValues>,
): void {
	const metadata = detectedMetadata.get(state) ?? new Map()
	metadata.set(modelId, { revision, values: structuredClone(values) })
	detectedMetadata.set(state, metadata)
	snapshots.delete(state)
}
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
		effective[row.id] = resolveModelValues(
			row.overrides,
			{
				...catalogModelValues(row, connection),
				...(detectedMetadata.get(state)?.get(row.id)?.revision === settings.revision
					? detectedMetadata.get(state)!.get(row.id)!.values
					: {}),
			},
			connection.defaults,
			managedModelValues(state, row, connection),
		)
		const contextWindow = effective[row.id].contextWindow.value
		planning[row.id] = { contextWindowKnown: contextWindow !== null, planningContextWindow: contextWindow ?? 128000 }
		let reason: string | undefined
		try {
			await assertConfiguredModelRequestAllowed(state, settings, { modelId: row.id, levelId: "default" })
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
		if (providers.length && !providers.includes(toLegacyApiProvider(provider) as never))
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
		for (const model of next.models.filter((row) => row.connectionId === connection.id)) {
			const previousModel = before.models.find((row) => row.id === model.id)
			const previousOptions = previousModel?.providerOptions ?? {}
			for (const key of new Set([...Object.keys(previousOptions), ...Object.keys(model.providerOptions)]))
				if (
					managed[key as keyof typeof managed] !== undefined &&
					changed(
						previousOptions[key as keyof typeof previousOptions],
						model.providerOptions[key as keyof typeof model.providerOptions],
					)
				)
					throw new Error(`Setting "${key}" is managed by your organization`)
		}
		const previousOptions = previous?.kind === "provider" ? previous.options : {}
		for (const key of new Set([...Object.keys(options), ...Object.keys(previousOptions)]))
			if (
				managed[key as keyof typeof managed] !== undefined &&
				changed(previousOptions[key as keyof typeof previousOptions], options[key as keyof typeof options])
			)
				throw new Error(`Setting "${key}" is managed by your organization`)

		const lockedFields: Record<string, [unknown, unknown]> =
			connection.kind === "openai-compatible"
				? {
						openAiBaseUrl: [previous?.baseUrl, connection.baseUrl],
						azureApiVersion: [
							previous?.kind === "openai-compatible" ? previous.azureApiVersion : undefined,
							connection.azureApiVersion,
						],
						azureIdentity: [previous?.auth.kind === "azure-identity", connection.auth.kind === "azure-identity"],
						openAiHeaders: [previous?.headers, connection.headers],
					}
				: connection.providerId === "anthropic"
					? { anthropicBaseUrl: [previous?.baseUrl, connection.baseUrl] }
					: {}
		for (const [key, [oldValue, value]] of Object.entries(lockedFields)) {
			if (managed[key as keyof typeof managed] !== undefined && changed(oldValue, value))
				throw new Error(`Setting "${key}" is managed by your organization`)
		}
		if (previous && connection.kind === "provider" && previous.kind === "provider") {
			for (const key of new Set([...Object.keys(previous.secretRefs), ...Object.keys(connection.secretRefs)]))
				if (
					managed[key as keyof typeof managed] !== undefined &&
					changed(previous.secretRefs[key], connection.secretRefs[key])
				)
					throw new Error(`Setting "${key}" is managed by your organization`)
		}
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

export function modelDependencies(
	state: StateManager,
	settings: ModelSettings,
	ids: string[],
	history: Array<{ id: string; modelSelectionV1?: unknown; apiSelection?: { modelSelectionV1?: unknown } }> = [],
) {
	const targets = new Set(ids)
	const dependencies: string[] = []
	const visit = (value: unknown, path: string): void => {
		if (!value || typeof value !== "object") return
		if ("modelId" in value && targets.has(String(value.modelId))) dependencies.push(path)
		for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`)
	}
	visit(settings.roles, "roles")
	visit(settings.subagents.allowed, "subagents.allowed")
	for (const item of [...(state.getGlobalStateKey("taskHistory") ?? []), ...history])
		visit(item.modelSelectionV1 ?? item.apiSelection?.modelSelectionV1, `thread:${item.id}`)
	return [...new Set(dependencies)]
}

/** Maintained catalog facts remain metadata, never user overrides. */
export function catalogModelValues(row: ModelRow, connection: ModelSettings["connections"][number]): Partial<ModelValues> {
	const providerId = connection.kind === "provider" ? connection.providerId : "openai-compatible"
	const model = createGateway()
		.listModels(providerId)
		.find((m) => m.id === row.upstreamId)
	if (!model) return {}
	return {
		...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
		...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
		...(model.maxInputTokens !== undefined ? { maxInputTokens: model.maxInputTokens } : {}),
		...Object.fromEntries(
			(
				[
					["images", "images"],
					["tools", "tools"],
					["reasoning", "reasoning"],
					["streaming", "streaming"],
					["files", "files"],
					["promptCache", "prompt-cache"],
				] as const
			)
				.filter(([, capability]) => model.capabilities?.includes(capability as never))
				.map(([key]) => [key, "yes"]),
		),
	}
}
export function managedModelValues(
	state: StateManager,
	row: ModelRow,
	connection: ModelSettings["connections"][number],
): Partial<ModelValues> {
	const managed = state.getRemoteConfigSettings() as Record<string, unknown>
	const values: Partial<ModelValues> = {}
	if (
		connection.kind === "provider" &&
		connection.providerId === "bedrock" &&
		typeof managed.awsBedrockUsePromptCache === "boolean"
	)
		values.promptCache = managed.awsBedrockUsePromptCache ? "yes" : "no"
	// Read only fields actually present in the managed state, never user model-info snapshots.
	const provider = toLegacyApiProvider(connection.kind === "provider" ? connection.providerId : "openai")
	for (const mode of ["act", "plan"] as const) {
		const key = getProviderModelIdKey(provider, mode)
		if (managed[key] !== row.upstreamId) continue
		const info = managed[key.replace(/Id$/, "Info")] as Record<string, unknown> | undefined
		if (!info) continue
		for (const [source, target] of [
			["contextWindow", "contextWindow"],
			["maxTokens", "maxOutputTokens"],
			["temperature", "temperature"],
			["inputPrice", "inputPrice"],
			["outputPrice", "outputPrice"],
			["thinkingBudgetTokens", "thinkingBudgetTokens"],
		] as const)
			if (typeof info[source] === "number") Object.assign(values, { [target]: info[source] })
		if (typeof info.supportsImages === "boolean") values.images = info.supportsImages ? "yes" : "no"
	}
	return values
}

/** Validate the selected request against current organization policy, including policy updates after save. */
export async function assertConfiguredModelRequestAllowed(
	state: StateManager,
	settings: ModelSettings,
	pick: { modelId: string; levelId: string },
	mode?: "act" | "plan",
): Promise<void> {
	const { model, connection } = resolveConfiguredPick(settings, pick)
	const managed = state.getRemoteConfigSettings() as Record<string, unknown>
	const provider = toLegacyApiProvider(connection.kind === "provider" ? connection.providerId : "openai")
	const providers = managed.remoteConfiguredProviders as string[] | undefined
	const fail = () => {
		throw new Error("This model configuration is managed by your organization. Open Settings > Models.")
	}
	if (providers?.length && !providers.includes(provider)) fail()
	const modes = mode ? [mode] : (["act", "plan"] as const)
	const lockedIds = modes
		.map((m) => managed[getProviderModelIdKey(provider, m)])
		.filter((id): id is string => typeof id === "string")
	if (lockedIds.length && !lockedIds.includes(model.upstreamId)) fail()
	const equal = (key: string, value: unknown) => {
		if (managed[key] !== undefined && JSON.stringify(managed[key]) !== JSON.stringify(value)) fail()
	}
	if (connection.kind === "openai-compatible") {
		equal("openAiBaseUrl", connection.baseUrl)
		equal("azureApiVersion", connection.azureApiVersion)
		equal("azureIdentity", connection.auth.kind === "azure-identity")
		if (managed.openAiHeaders !== undefined) {
			const headers: Record<string, string | undefined> = {}
			for (const header of connection.headers)
				headers[header.name.toLowerCase()] =
					header.storage === "plain" ? header.value : await state.connectionSecrets?.get(header.secretRef)
			const expected = Object.fromEntries(
				Object.entries(managed.openAiHeaders as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
			)
			if (
				Object.keys(headers).length !== Object.keys(expected).length ||
				Object.entries(expected).some(([k, v]) => headers[k] !== v)
			)
				fail()
		}
	} else {
		const prefix: Record<string, string> = { bedrock: "aws", vertex: "vertex", litellm: "liteLlm" }
		for (const key of Object.keys(managed)) {
			if (!prefix[provider] || !key.startsWith(prefix[provider])) continue
			if (key in connection.options) equal(key, connection.options[key as keyof typeof connection.options])
			else if (key in model.providerOptions) equal(key, model.providerOptions[key as keyof typeof model.providerOptions])
			else fail()
		}
		if (provider === "anthropic") equal("anthropicBaseUrl", connection.baseUrl)
		for (const [key, value] of Object.entries(managed)) {
			if (Object.hasOwn(connection.options, key)) equal(key, connection.options[key as keyof typeof connection.options])
			if (Object.hasOwn(model.providerOptions, key))
				equal(key, model.providerOptions[key as keyof typeof model.providerOptions])
			if (Object.hasOwn(connection.secretRefs, key))
				equal(key, await state.connectionSecrets?.get(connection.secretRefs[key]))
		}
	}
}
