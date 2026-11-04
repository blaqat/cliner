import { z } from "zod"
import type { ApiHandlerOptions } from "./api"

export type ConnectionId = string // generated UUID, immutable
export type ModelId = string // configured row UUID, not the upstream model ID
export type LevelId = string // stable token within one model; labels can change
export type SecretRef = string // opaque keychain key, never a value
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type ApiFormat = "chat" | "responses"
export type Knowledge = "yes" | "no" | "unknown"
export type { LevelRequest } from "@cline/llms"

import type { LevelRequest } from "@cline/llms"
export type ModelLevel = {
	id: LevelId
	label: string
	rank: number // ascending cost/intensity order, independent of display order
	request: LevelRequest
}
export type Header =
	| { id: string; name: string; storage: "plain"; value: string }
	| { id: string; name: string; storage: "secret"; secretRef: SecretRef }
export type ConnectionAuth =
	| { kind: "keychain"; secretRef: SecretRef }
	| { kind: "environment"; variable: string }
	| { kind: "azure-identity" }
	| { kind: "none" }
	| { kind: "sdk-account"; providerId: string }
export type ModelValues = {
	contextWindow: number | null
	maxOutputTokens: number | null
	maxInputTokens: number | null
	images: Knowledge
	tools: Knowledge
	reasoning: Knowledge
	streaming: Knowledge
	promptCache: Knowledge
	files: Knowledge
	levels: ModelLevel[]
	temperature: number | null
	verbosity: "low" | "medium" | "high" | null
	thinkingBudgetTokens: number | null
	extraBody: Record<string, Json>
	inputPrice: number | null
	outputPrice: number | null
	cacheReadPrice: number | null
	cacheWritePrice: number | null
	free: boolean
	systemRole: "system" | "developer"
	apiFormat: ApiFormat | null // null inherits connection transport
}
export type ConnectionBase = {
	id: ConnectionId
	name: string
	baseUrl: string | null
	auth: ConnectionAuth
	headers: Header[]
	requestTimeoutMs: number | null // null inherits Models request timeout
	defaults: Partial<ModelValues>
}
export type CompatibleConnection = ConnectionBase & {
	kind: "openai-compatible"
	apiFormat: ApiFormat
	azureApiVersion: string | null
}
// Preserve provider-specific values with the existing typed option vocabulary.
// Host validators reject secret fields and fields that belong to a model/mode.
export type ProviderConnection = ConnectionBase & {
	kind: "provider"
	providerId: string // canonical SDK spelling
	options: Partial<ApiHandlerOptions> & { ocaUsePromptCache?: boolean }
	secretRefs: Record<string, SecretRef>
}
export type Connection = CompatibleConnection | ProviderConnection
export type ModelRow = {
	id: ModelId
	connectionId: ConnectionId
	upstreamId: string
	name: string // empty displays upstreamId
	kind: "chat" | "non-chat" | "unknown"
	overrides: Partial<ModelValues>
	providerOptions: Partial<ApiHandlerOptions> // model-specific settings only
	legacyMetadata?: { source: "legacy"; sdk?: Record<string, Json>; modelInfo?: Record<string, Json> }
}
export type ModelPick = { modelId: ModelId; levelId: LevelId }
export type ThreadModelPick = { kind: "thread"; level: "inherit" | LevelId }
export type SubagentPick = { kind: "model"; pick: ModelPick } | ThreadModelPick
export type BackgroundUse = "titles" | "commitMessages" | "generate"
export type RoleSettings = {
	chat: ModelPick | null
	ask: { enabled: boolean; pick: ModelPick | null }
	subagents: SubagentPick
	background: {
		pick: ModelPick | null
		titlesEnabled: boolean
		overrides: Partial<Record<BackgroundUse, ModelPick>>
	}
}
export type AllowedSubagentModel =
	| { kind: "model"; modelId: ModelId; levels: LevelId[] }
	| { kind: "thread"; levels: Array<LevelId | "inherit"> }
export type SubagentPolicy = {
	enabled: boolean
	maxConcurrent: number // integer >= 0; default 3; legacy explicit 0 is unlimited
	access: { write: boolean; commands: boolean; web: boolean; mcp: boolean }
	blocking: "never" | "parent-decides" | "always"
	allowed: AllowedSubagentModel[]
}
export type ModelSettings = {
	version: 1
	revision: number
	connections: Connection[]
	models: ModelRow[]
	roles: RoleSettings
	subagents: SubagentPolicy
	requestTimeoutMs: number | null
}
export type ThreadModelSelection = {
	version: 1
	ask: ModelPick | null
	act: ModelPick | null
}
export type NextMessageSelection = { mode: "plan" | "act"; pick: ModelPick }
export type ModelMetadata = {
	modelId: ModelId
	values: Partial<ModelValues>
	source: "catalog" | "detected"
	fetchedAt: number
}
export type EffectiveField<T> = {
	value: T
	source: "managed" | "model" | "metadata" | "connection" | "builtin"
}
export type ModelSettingsMigration = {
	version: 1
	status: "prepared" | "complete"
	backupId: string
	configurationModels: Record<string, ModelId>
	profilePicks: Record<string, ModelPick>
	legacyFingerprint: string // nonsecret configuration only
	completedAt?: number
}

const id = z.string().min(1)
const token = z.number().int().positive().nullable()
const nonnegative = z.number().finite().nonnegative().nullable()
const knowledge = z.enum(["yes", "no", "unknown"])
const json: z.ZodType<Json> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(z.string(), json)]),
)
export const LevelRequestSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("default") }).strict(),
	z.object({ kind: z.literal("effort"), value: id }).strict(),
	z.object({ kind: z.literal("thinking-budget"), tokens: z.number().int().positive() }).strict(),
	z.object({ kind: z.literal("thinking-level"), value: id }).strict(),
])
export const ModelLevelSchema = z
	.object({ id, label: id, rank: z.number().finite(), request: LevelRequestSchema })
	.strict()
	.refine((v) => (v.id === "default") === (v.request.kind === "default"), "Reserve default for omission")
const reservedBodyKeys = new Set([
	"system",
	"system_instruction",
	"generationconfig",
	"generation_config",
	"inferenceconfig",
	"additionalmodelrequestfields",
	"maxtokens",
	"maxoutputtokens",
	"maxcompletiontokens",
	"reasoningconfig",
	"thinkingconfig",
	"toolconfig",
	"contents",
	"systeminstruction",
	"prompt",
	"modelid",
	"model_id",
	"model",
	"messages",
	"input",
	"instructions",
	"tools",
	"tool_choice",
	"stream",
	"stream_options",
	"max_tokens",
	"max_completion_tokens",
	"max_output_tokens",
	"reasoning",
	"reasoning_effort",
	"thinking",
	"thinking_budget",
	"thinking_config",
	"temperature",
	"verbosity",
	"text",
	"api_key",
	"apikey",
	"authorization",
	"headers",
	"access_token",
	"token",
])
export const ExtraBodySchema = z
	.record(z.string(), json)
	.refine(
		(v) =>
			Object.keys(v).every(
				(k) =>
					!reservedBodyKeys.has(k.toLowerCase()) &&
					!/secret|authorization|password|credential|api.?key|access.?token/i.test(k),
			),
		"Use dedicated controls for reserved request fields",
	)
export const ModelValuesSchema = z
	.object({
		contextWindow: token,
		maxOutputTokens: token,
		maxInputTokens: token,
		images: knowledge,
		tools: knowledge,
		reasoning: knowledge,
		streaming: knowledge,
		promptCache: knowledge,
		files: knowledge,
		levels: z
			.array(ModelLevelSchema)
			.min(1)
			.refine((v) => new Set(v.map((l) => l.id)).size === v.length, "Duplicate level ID"),
		temperature: nonnegative,
		verbosity: z.enum(["low", "medium", "high"]).nullable(),
		thinkingBudgetTokens: token,
		extraBody: ExtraBodySchema,
		inputPrice: nonnegative,
		outputPrice: nonnegative,
		cacheReadPrice: nonnegative,
		cacheWritePrice: nonnegative,
		free: z.boolean(),
		systemRole: z.enum(["system", "developer"]),
		apiFormat: z.enum(["chat", "responses"]).nullable(),
	})
	.strict()
export const BUILTIN_MODEL_VALUES: ModelValues = {
	contextWindow: null,
	maxOutputTokens: null,
	maxInputTokens: null,
	images: "unknown",
	tools: "unknown",
	reasoning: "unknown",
	streaming: "unknown",
	promptCache: "unknown",
	files: "unknown",
	levels: [{ id: "default", label: "Default", rank: 0, request: { kind: "default" } }],
	temperature: null,
	verbosity: null,
	thinkingBudgetTokens: null,
	extraBody: {},
	inputPrice: null,
	outputPrice: null,
	cacheReadPrice: null,
	cacheWritePrice: null,
	free: false,
	systemRole: "system",
	apiFormat: null,
}
export const ConnectionAuthSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("keychain"), secretRef: id }).strict(),
	z.object({ kind: z.literal("environment"), variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
	z.object({ kind: z.literal("azure-identity") }).strict(),
	z.object({ kind: z.literal("none") }).strict(),
	z.object({ kind: z.literal("sdk-account"), providerId: id }).strict(),
])
export const HeaderSchema = z
	.discriminatedUnion("storage", [
		z.object({ id, name: id, storage: z.literal("plain"), value: z.string() }).strict(),
		z.object({ id, name: id, storage: z.literal("secret"), secretRef: id }).strict(),
	])
	.refine(
		(h) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.name) && (h.storage !== "plain" || !/[\r\n]/.test(h.value)),
		"Invalid header",
	)
// Explicitly partition legacy provider fields. Credentials only appear as secretRefs.
const connectionOptionShape = {
	openRouterProviderSorting: z.string(),
	liteLlmBaseUrl: z.string(),
	liteLlmUsePromptCache: z.boolean(),
	requestyBaseUrl: z.string(),
	awsRegion: z.string(),
	awsAuthentication: z.string(),
	awsUseProfile: z.boolean(),
	awsProfile: z.string(),
	awsBedrockEndpoint: z.string(),
	claudeCodePath: z.string(),
	vertexProjectId: z.string(),
	vertexRegion: z.string(),
	geminiBaseUrl: z.string(),
	qwenCodeOauthPath: z.string(),
	qwenApiLine: z.string(),
	moonshotApiLine: z.string(),
	tasksageApiUrl: z.string(),
	sapAiResourceGroup: z.string(),
	sapAiCoreTokenUrl: z.string(),
	sapAiCoreBaseUrl: z.string(),
	sapAiCoreUseOrchestrationMode: z.boolean(),
	difyBaseUrl: z.string(),
	zaiApiLine: z.string(),
	ocaBaseUrl: z.string(),
	minimaxApiLine: z.string(),
	ocaMode: z.string(),
	ocaUsePromptCache: z.boolean(),
	aihubmixBaseUrl: z.string(),
	aihubmixAppCode: z.string(),
}
export const ConnectionOptionsSchema = z.object(connectionOptionShape).partial().strict()
export const ModelProviderOptionsSchema = z
	.object({
		awsUseCrossRegionInference: z.boolean(),
		awsUseGlobalInference: z.boolean(),
		awsBedrockUsePromptCache: z.boolean(),
		actModeAwsBedrockCustomSelected: z.boolean(),
		actModeAwsBedrockCustomModelBaseId: z.string(),
		actModeSapAiCoreDeploymentId: z.string(),
		actModeVsCodeLmModelSelector: z.record(z.string(), z.string()),
		ollamaApiOptionsCtxNum: z.string(),
		lmStudioMaxTokens: z.string(),
		fireworksModelMaxCompletionTokens: z.number().int().positive(),
		fireworksModelMaxTokens: z.number().int().positive(),
	})
	.partial()
	.strict()
const connectionBase = {
	id,
	name: z.string(),
	baseUrl: z.string().url().nullable(),
	auth: ConnectionAuthSchema,
	headers: z
		.array(HeaderSchema)
		.refine((v) => new Set(v.map((h) => h.name.toLowerCase())).size === v.length, "Duplicate header name"),
	requestTimeoutMs: token,
	defaults: ModelValuesSchema.partial(),
}
export const ConnectionSchema = z
	.discriminatedUnion("kind", [
		z
			.object({
				...connectionBase,
				kind: z.literal("openai-compatible"),
				apiFormat: z.enum(["chat", "responses"]),
				azureApiVersion: z.string().nullable(),
			})
			.strict(),
		z
			.object({
				...connectionBase,
				kind: z.literal("provider"),
				providerId: id,
				options: ConnectionOptionsSchema,
				secretRefs: z.record(id, id),
			})
			.strict(),
	])
	.superRefine((connection, ctx) => {
		const refs = [
			...(connection.auth.kind === "keychain" ? [connection.auth.secretRef] : []),
			...connection.headers.flatMap((h) => (h.storage === "secret" ? [h.secretRef] : [])),
			...(connection.kind === "provider" ? Object.values(connection.secretRefs) : []),
		]
		for (const ref of refs)
			if (!ref.startsWith(`settings:v1:connection:${connection.id}:`))
				ctx.addIssue({ code: "custom", message: "Secret reference belongs to another connection" })
	})
export const ModelRowSchema = z
	.object({
		id,
		connectionId: id,
		upstreamId: id,
		name: z.string(),
		kind: z.enum(["chat", "non-chat", "unknown"]),
		overrides: ModelValuesSchema.partial(),
		providerOptions: ModelProviderOptionsSchema,
		legacyMetadata: z
			.object({
				source: z.literal("legacy"),
				sdk: z.record(z.string(), json).optional(),
				modelInfo: z.record(z.string(), json).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
export const ModelPickSchema = z.object({ modelId: id, levelId: id }).strict()
export const ThreadModelPickSchema = z.object({ kind: z.literal("thread"), level: id }).strict()
export const SubagentPickSchema = z.union([
	z.object({ kind: z.literal("model"), pick: ModelPickSchema }).strict(),
	ThreadModelPickSchema,
])
export const RoleSettingsSchema = z
	.object({
		chat: ModelPickSchema.nullable(),
		ask: z.object({ enabled: z.boolean(), pick: ModelPickSchema.nullable() }).strict(),
		subagents: SubagentPickSchema,
		background: z
			.object({
				pick: ModelPickSchema.nullable(),
				titlesEnabled: z.boolean(),
				overrides: z
					.object({
						titles: ModelPickSchema.optional(),
						commitMessages: ModelPickSchema.optional(),
						generate: ModelPickSchema.optional(),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
export const AllowedSubagentModelSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("model"), modelId: id, levels: z.array(id) }).strict(),
	z.object({ kind: z.literal("thread"), levels: z.array(id) }).strict(),
])
export const SubagentPolicySchema = z
	.object({
		enabled: z.boolean(),
		maxConcurrent: z.number().int().nonnegative(),
		access: z.object({ write: z.boolean(), commands: z.boolean(), web: z.boolean(), mcp: z.boolean() }).strict(),
		blocking: z.enum(["never", "parent-decides", "always"]),
		allowed: z.array(AllowedSubagentModelSchema),
	})
	.strict()
export const ModelMetadataSchema = z
	.object({
		modelId: id,
		values: ModelValuesSchema.partial(),
		source: z.enum(["catalog", "detected"]),
		fetchedAt: z.number().finite().nonnegative(),
	})
	.strict()
export const ThreadModelSelectionSchema = z
	.object({ version: z.literal(1), ask: ModelPickSchema.nullable(), act: ModelPickSchema.nullable() })
	.strict()
export const NextMessageSelectionSchema = z.object({ mode: z.enum(["plan", "act"]), pick: ModelPickSchema }).strict()
export const ModelSettingsMigrationSchema = z
	.object({
		version: z.literal(1),
		status: z.enum(["prepared", "complete"]),
		backupId: id,
		configurationModels: z.record(id, id),
		profilePicks: z.record(id, ModelPickSchema),
		legacyFingerprint: z.string(),
		completedAt: z.number().optional(),
	})
	.strict()
export const ModelSettingsSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		connections: z.array(ConnectionSchema),
		models: z.array(ModelRowSchema),
		roles: RoleSettingsSchema,
		subagents: SubagentPolicySchema,
		requestTimeoutMs: token,
	})
	.strict()
	.superRefine((s, ctx) => {
		const issue = (message: string) => ctx.addIssue({ code: "custom", message })
		for (const rows of [s.connections, s.models])
			if (new Set(rows.map((r) => r.id)).size !== rows.length) issue("Duplicate configured ID")
		for (const m of s.models) if (!s.connections.some((c) => c.id === m.connectionId)) issue("Missing connection")
		const check = (p: ModelPick | null) => {
			if (!p) return
			const m = s.models.find((m) => m.id === p.modelId)
			const c = s.connections.find((c) => c.id === m?.connectionId)
			if (!m || !c) {
				issue("Missing model or connection")
				return
			}
			const values = resolveModelValues(m.overrides, undefined, c.defaults)
			if (!values.levels.value.some((l) => l.id === p.levelId)) issue("Invalid saved level")
			if (values.reasoning.value !== "yes" && p.levelId !== "default") issue("Reasoning is unknown or unsupported")
		}
		check(s.roles.chat)
		check(s.roles.ask.pick)
		check(s.roles.background.pick)
		for (const p of Object.values(s.roles.background.overrides)) check(p)
		if (s.roles.subagents.kind === "model") check(s.roles.subagents.pick)
		for (const a of s.subagents.allowed)
			if (a.kind === "model") for (const levelId of a.levels) check({ modelId: a.modelId, levelId })
	})
export function createDefaultModelSettings(): ModelSettings {
	return {
		version: 1,
		revision: 0,
		connections: [],
		models: [],
		roles: {
			chat: null,
			ask: { enabled: false, pick: null },
			subagents: { kind: "thread", level: "inherit" },
			background: { pick: null, titlesEnabled: false, overrides: {} },
		},
		subagents: {
			enabled: true,
			maxConcurrent: 3,
			access: { write: true, commands: true, web: true, mcp: true },
			blocking: "parent-decides",
			allowed: [],
		},
		requestTimeoutMs: null,
	}
}
export function createCompatibleConnection(id: ConnectionId, name = ""): CompatibleConnection {
	return {
		id,
		name,
		kind: "openai-compatible",
		baseUrl: null,
		auth: { kind: "keychain", secretRef: `settings:v1:connection:${id}:apiKey` },
		headers: [],
		requestTimeoutMs: null,
		defaults: {},
		apiFormat: "chat",
		azureApiVersion: null,
	}
}
export function resolveModelValues(
	model: Partial<ModelValues>,
	metadata: Partial<ModelValues> | undefined,
	connection: Partial<ModelValues>,
	managed: Partial<ModelValues> = {},
): { [K in keyof ModelValues]: EffectiveField<ModelValues[K]> } {
	const result = {} as { [K in keyof ModelValues]: EffectiveField<ModelValues[K]> }
	for (const key of Object.keys(BUILTIN_MODEL_VALUES) as (keyof ModelValues)[]) {
		const layers = [
			["managed", managed],
			["model", model],
			["metadata", metadata ?? {}],
			["connection", connection],
			["builtin", BUILTIN_MODEL_VALUES],
		] as const
		const layer = layers.find(([, v]) => Object.hasOwn(v, key) && v[key] !== undefined)!
		Object.assign(result, { [key]: { value: structuredClone(layer[1][key]), source: layer[0] } })
	}
	return result
}
