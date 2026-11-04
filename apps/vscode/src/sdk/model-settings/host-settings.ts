import { createGateway } from "@cline/llms"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import {
	ConnectionSchema,
	createDefaultModelSettings,
	type ModelLevel,
	type ModelPick,
	type ModelSettings,
	type ModelValues,
	type ModelRow,
	ModelSettingsSchema,
	resolveModelValues,
} from "@shared/model-settings"
import type { ModelSettingsFixTarget, ModelSettingsState } from "@shared/model-settings-state"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import type { StateManager } from "@/core/storage/StateManager"
import { connectionProviderOptions } from "./provider-options"
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
		availability[row.id] = {
			available: !reason,
			...(reason ? { reason, target: { page: "models", connectionId: connection.id } } : {}),
		}
	}
	const { roles } = settings
	const backgroundUse = (use: "generate" | "commitMessages" | "titles") =>
		[roles.background.overrides[use] ?? roles.background.pick, roles.background.overrides[use] ? use : "background"] as const
	for (const [name, [pick, role]] of Object.entries({
		"role.chat": [roles.chat, "chat"],
		"role.ask": roles.ask.enabled ? [roles.ask.pick, "ask"] : [roles.chat, "chat"],
		"role.background": [roles.background.pick, "background"],
		...(roles.subagents.kind === "model" ? { "role.subagents": [roles.subagents.pick, "subagents"] } : {}),
		"background.generate": backgroundUse("generate"),
		"background.commitMessages": backgroundUse("commitMessages"),
		"background.titles": backgroundUse("titles"),
	} as Record<string, readonly [ModelPick | null, string]>)) {
		try {
			resolveEffectiveConfiguredPick(state, settings, pick)
			availability[name] = availability[pick!.modelId]
		} catch (error) {
			availability[name] = {
				available: false,
				reason: error instanceof Error ? error.message : "Choose a model in Settings > Models",
				target: pickFixTarget(settings, pick, role),
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

/** The control that fixes a pick the resolver refused: the role when its model is gone, otherwise the model. */
function pickFixTarget(settings: ModelSettings, pick: ModelPick | null, role: string): ModelSettingsFixTarget {
	const model = settings.models.find((row) => row.id === pick?.modelId)
	if (!model) return { page: "models", role }
	return model.kind === "non-chat"
		? { page: "models", modelId: model.id }
		: { page: "models", modelId: model.id, field: "levels" }
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

/**
 * Saved threads whose stored picks name these models. Live, pending and next-message entries belong to
 * their thread; the home draft and in-flight background calls aren't saved threads.
 */
export function savedThreadsUsingModels(
	state: StateManager,
	ids: string[],
	history: Array<{ id: string; modelSelectionV1?: unknown; apiSelection?: { modelSelectionV1?: unknown } }>,
): string[] {
	const targets = new Set(ids)
	const uses = (value: unknown): boolean =>
		!!value &&
		typeof value === "object" &&
		(("modelId" in value && targets.has(String(value.modelId))) || Object.values(value).some(uses))
	const threads = new Set<string>()
	for (const item of [...(state.getGlobalStateKey("taskHistory") ?? []), ...history]) {
		const selection = item.modelSelectionV1 ?? item.apiSelection?.modelSelectionV1
		const [threadId, suffix] = item.id.split(":")
		const owned = suffix === undefined || THREAD_SELECTION_SUFFIXES.has(suffix)
		if (threadId && threadId !== "home" && owned && uses(selection)) threads.add(threadId)
	}
	return [...threads]
}
const THREAD_SELECTION_SUFFIXES = new Set(["live", "pending", "previous", "next-message"])

/** Same metadata and managed precedence for publication and request construction. */
export function configuredModelMetadata(
	state: StateManager,
	settings: ModelSettings,
	model: ModelRow,
	connection: ModelSettings["connections"][number],
) {
	const detected = detectedMetadata.get(state)?.get(model.id)
	return {
		modelId: model.id,
		source: "catalog" as const,
		fetchedAt: Date.now(),
		values: {
			...catalogModelValues(model, connection),
			...(detected?.revision === settings.revision ? detected.values : {}),
		},
	}
}

const CATALOG_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
const defaultLevel: ModelLevel = { id: "default", label: "Default", rank: 0, request: { kind: "default" } }
const effortLevels = (efforts: string[]): ModelLevel[] => [
	defaultLevel,
	...efforts.map(
		(value, index): ModelLevel => ({ id: value, label: value, rank: index + 1, request: { kind: "effort", value } }),
	),
]
/**
 * Levels a catalog model's reasoning metadata advertises. Effort values map one to one, and a budget range
 * gets three points inside it. With no metadata the SDK sends only broadly supported efforts, so those are
 * what's offered. A toggle alone, or an empty list, has nothing to choose between.
 */
export function catalogReasoningLevels(model: {
	capabilities?: readonly string[]
	reasoningOptions?: ReadonlyArray<{ type: string; values?: ReadonlyArray<string | null>; min?: number; max?: number }>
}): ModelLevel[] | undefined {
	if (!model.capabilities?.includes("reasoning")) return undefined
	if (!model.reasoningOptions) return effortLevels(["low", "medium", "high"])
	const advertised = model.reasoningOptions.flatMap((option) => (option.type === "effort" ? (option.values ?? []) : []))
	const efforts = CATALOG_EFFORTS.filter((effort) => advertised.includes(effort))
	if (efforts.length) return effortLevels(efforts)
	const budget = model.reasoningOptions.find((option) => option.type === "budget_tokens")
	if (!budget?.max || budget.max <= 0) return undefined
	const floor = Math.max(budget.min ?? 1, 1)
	const points = [
		["low", "Low", budget.max / 4],
		["medium", "Medium", budget.max / 2],
		["high", "High", budget.max],
	] as const
	return [
		defaultLevel,
		...points.map(
			([id, label, tokens], index): ModelLevel => ({
				id,
				label,
				rank: index + 1,
				request: { kind: "thinking-budget", tokens: Math.max(Math.round(tokens), floor) },
			}),
		),
	]
}

/** Maintained catalog facts remain metadata, never user overrides. */
export function catalogModelValues(row: ModelRow, connection: ModelSettings["connections"][number]): Partial<ModelValues> {
	const providerId = connection.kind === "provider" ? connection.providerId : "openai-compatible"
	const model = createGateway()
		.listModels(providerId)
		.find((m) => m.id === row.upstreamId)
	if (!model) return {}
	const levels = catalogReasoningLevels(model)
	return {
		...(levels ? { levels } : {}),
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
function remoteProviderTable(state: StateManager, connection: ModelSettings["connections"][number]) {
	const names: Record<string, string> = {
		openai: "OpenAiCompatible",
		bedrock: "AwsBedrock",
		cline: "Cline",
		vertex: "Vertex",
		litellm: "LiteLLM",
		anthropic: "Anthropic",
	}
	const provider = toLegacyApiProvider(connection.kind === "provider" ? connection.providerId : "openai")
	const tables = state.getRemoteConfigSettings().remoteProviderSettings as
		| Record<string, { models?: Array<Record<string, unknown>>; customModels?: Array<Record<string, unknown>> }>
		| undefined
	return tables?.[names[provider]]
}
export function managedModelValues(
	state: StateManager,
	row: ModelRow,
	connection: ModelSettings["connections"][number],
): Partial<ModelValues> {
	const managed = state.getRemoteConfigSettings() as Record<string, unknown>
	const values: Partial<ModelValues> = {}
	const table = remoteProviderTable(state, connection)
	const entry = [...(table?.models ?? []), ...(table?.customModels ?? [])].find(
		(entry) => (entry.id ?? entry.name) === row.upstreamId,
	)
	if (entry) {
		for (const [source, target] of [
			["contextWindow", "contextWindow"],
			["maxTokens", "maxOutputTokens"],
			["temperature", "temperature"],
			["inputPrice", "inputPrice"],
			["outputPrice", "outputPrice"],
			["thinkingBudgetTokens", "thinkingBudgetTokens"],
		] as const)
			if (typeof entry[source] === "number") Object.assign(values, { [target]: entry[source] })
		if (typeof entry.supportsImages === "boolean") values.images = entry.supportsImages ? "yes" : "no"
		if (typeof entry.promptCachingEnabled === "boolean") values.promptCache = entry.promptCachingEnabled ? "yes" : "no"
	}
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

/** Validate levels against the same effective fields used to construct the request. */
export function resolveEffectiveConfiguredPick(state: StateManager, settings: ModelSettings, pick: ModelPick | null) {
	const model = settings.models.find((row) => row.id === pick?.modelId)
	const connection = settings.connections.find((row) => row.id === model?.connectionId)
	if (!model || !connection) return resolveConfiguredPick(settings, pick)
	return resolveConfiguredPick(
		settings,
		pick,
		configuredModelMetadata(state, settings, model, connection),
		managedModelValues(state, model, connection),
	)
}

/** Validate the selected request against current organization policy, including policy updates after save. */
export async function assertConfiguredModelRequestAllowed(
	state: StateManager,
	settings: ModelSettings,
	pick: { modelId: string; levelId: string },
	mode?: "act" | "plan",
): Promise<void> {
	const { model, connection } = resolveEffectiveConfiguredPick(state, settings, pick)
	const managed = state.getRemoteConfigSettings() as Record<string, unknown>
	const provider = toLegacyApiProvider(connection.kind === "provider" ? connection.providerId : "openai")
	const providers = managed.remoteConfiguredProviders as string[] | undefined
	const fail = () => {
		throw new Error("This model configuration is managed by your organization. Open Settings > Models.")
	}
	if (providers?.length && !providers.includes(provider)) fail()
	const table = remoteProviderTable(state, connection)
	if (
		table &&
		(table.models !== undefined || table.customModels !== undefined) &&
		![...(table.models ?? []), ...(table.customModels ?? [])].some((entry) => (entry.id ?? entry.name) === model.upstreamId)
	)
		fail()
	const customModel = table?.customModels?.find((entry) => entry.name === model.upstreamId)
	if (
		customModel?.baseModelId !== undefined &&
		connectionProviderOptions(connection, {}, model).customModelBaseId !== customModel.baseModelId
	)
		fail()
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
