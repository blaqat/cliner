import { createHash } from "node:crypto"
import { createGateway } from "@cline/llms"
import { isAllowedApiProvider } from "@shared/api-profiles"
import {
	BASE_URL_NEEDED,
	type Connection,
	ConnectionOptionsSchema,
	ConnectionSchema,
	createDefaultModelSettings,
	type Header,
	type Json,
	MODEL_ID_NEEDED,
	type ModelLevel,
	type ModelPick,
	ModelProviderOptionsSchema,
	type ModelRow,
	ModelRowSchema,
	type ModelSettingsMigration,
	ModelSettingsSchema,
} from "@shared/model-settings"
import type { ModelSettingsMigrationIssue } from "@shared/model-settings-migration-status"
import type { ClineMemento } from "@shared/storage/ClineStorage"
import { getProviderDefaultModelId, getProviderModelIdKey } from "@shared/storage/provider-keys"
import { ApiHandlerSettingsKeys, SecretKeys } from "@shared/storage/state-keys"
import { toSdkProviderId } from "@/sdk/model-catalog/sdk-provider-id"
import type { ConnectionSecretStore } from "@/sdk/model-settings/connection-secret-store"
import { catalogReasoningLevels } from "@/sdk/model-settings/host-settings"
import { closestOfferedLevel, legacyModelValues, migratedLevels, sdkModelValues } from "@/sdk/model-settings/legacy-values"
import { providerOptionMappings, providerSecretFields } from "@/sdk/model-settings/provider-options"
import { modelSettingsRolloutEnabled } from "@/sdk/model-settings/rollout"

function stable(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
			: v,
	)
}
type RecordValue = Record<string, unknown>
const record = (v: unknown): RecordValue | undefined =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : undefined
const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex")
const pickFields = (v: unknown, fields: readonly string[]): RecordValue =>
	Object.fromEntries(Object.entries(record(v) ?? {}).filter(([k]) => fields.includes(k)))
/** Model metadata keeps its nested shape, so its secret-looking fields are removed by name. */
function withoutSecretNames(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(withoutSecretNames)
	if (v && typeof v === "object")
		return Object.fromEntries(
			Object.entries(v)
				.filter(([k]) => !/secret|token(?!s$)|api.?key|password|credential|authorization/i.test(k))
				.map(([k, x]) => [k, withoutSecretNames(x)]),
		)
	return v
}

// The backup holds only what's listed here. A field it doesn't name stays out, whatever it's called.
const BACKUP_SELECTION_KEYS = [
	"askProfileId",
	"actProfileId",
	"profilesMigration",
	"threadSelectionStamp",
	"threadDefaultProfileId",
	"threadSeparateAskActProfiles",
	"threadAskProfileId",
	"threadActProfileId",
	"threadTitlesEnabled",
	"threadTitlesModelProfileId",
	"threadTitlesProfileId",
	"walkthroughGenerateModelProfileId",
	"walkthroughGenerateProfileId",
	"subagentProfilesEnabled",
	"subagentDefaultModelProfileId",
	"subagentDefaultProfileId",
	"subagentReasoningEffort",
	"subagentAllowedModelProfileIds",
	"subagentAllowedProfileIds",
	"subagentsEnabled",
	"subagentsMaxConcurrent",
	"subagentsAllowWrite",
	"subagentsAllowCommands",
	"subagentsAllowWeb",
	"subagentsAllowMcp",
]
const BACKUP_CONFIGURATION_FIELDS = ["id", "name", "provider", "modelId", "openAiCompatibleApiType", "reasoningEffort"]
const BACKUP_PROFILE_FIELDS = ["id", "name", "configurationId", "reasoningEffort"]
const BACKUP_MODEL_INFO_FIELDS = [
	"name",
	"contextWindow",
	"maxTokens",
	"maxInputTokens",
	"inputPrice",
	"outputPrice",
	"cacheReadsPrice",
	"cacheWritesPrice",
	"temperature",
	"supportsImages",
	"supportsVision",
	"supportsAttachments",
	"supportsPromptCache",
	"supportsReasoning",
	"supportsTools",
	"supportsStreaming",
	"systemRole",
	"capabilities",
	"operation",
	"apiFormat",
]
/** Only scheme, host and path: a saved URL can carry credentials in its userinfo or query. */
function backupUrl(v: unknown): string | undefined {
	try {
		const url = new URL(String(v))
		return `${url.protocol}//${url.host}${url.pathname}`
	} catch {
		return undefined
	}
}
function backupSetting(key: string, v: unknown): unknown {
	if (key === "openAiHeaders") return { names: Object.keys(record(v) ?? {}).filter((name) => HEADER_NAME.test(name)) }
	if (key.endsWith("ModelInfo")) return pickFields(v, BACKUP_MODEL_INFO_FIELDS)
	if (/(url|endpoint)$/i.test(key)) return backupUrl(v)
	return typeof v === "object" ? undefined : v
}
const backupSettings = (v: unknown): RecordValue =>
	Object.fromEntries(
		Object.entries(record(v) ?? {})
			.filter(([k]) => (ApiHandlerSettingsKeys as readonly string[]).includes(k))
			.map(([k, x]) => [k, backupSetting(k, x)]),
	)
function backupLegacy(raw: RecordValue): RecordValue {
	const configurations = Array.isArray(raw.apiConfigProfiles) ? raw.apiConfigProfiles : []
	return {
		...backupSettings(raw),
		...pickFields(raw, BACKUP_SELECTION_KEYS),
		apiConfigProfiles: configurations.map((c) => ({
			...pickFields(c, BACKUP_CONFIGURATION_FIELDS),
			options: backupSettings(record(c)?.options),
		})),
		profiles: [raw.modelProfiles, raw.profiles].flatMap((list) =>
			Array.isArray(list) ? list.map((p) => pickFields(p, BACKUP_PROFILE_FIELDS)) : [],
		),
	}
}
function backupSdk(input: RecordValue): RecordValue {
	const providers = record(input.providers)
	const models = record(input.models)
	const each = (v: unknown, map: (x: unknown) => unknown) =>
		Object.fromEntries(Object.entries(record(v) ?? {}).map(([k, x]) => [k, map(x)]))
	return {
		lastUsedProvider: text(providers?.lastUsedProvider),
		providers: each(providers?.providers, (entry) => {
			const settings = record(record(entry)?.settings)
			return { model: text(settings?.model), baseUrl: settings?.baseUrl ? backupUrl(settings.baseUrl) : undefined }
		}),
		models: each(models?.providers, (entry) => ({
			models: each(record(entry)?.models, (m) => pickFields(m, BACKUP_MODEL_INFO_FIELDS)),
		})),
	}
}

const LOCKED_HEADER = /auth|cookie|key|token|secret|password|passwd|credential|session|signature/i
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const NO_KEY_PROVIDERS = [
	"ollama",
	"lmstudio",
	"bedrock",
	"vertex",
	"claude-code",
	"qwen-code",
	"openai-codex",
	"opencode",
	"sapaicore",
	"vscode-lm",
]
const ACCOUNT_PROVIDERS = ["cline", "cline-pass", "oca"]
/** Signing in keeps refreshing this token in the old store, so a copy would only go stale. */
const ACCOUNT_TOKEN_FIELDS: Record<string, string> = { oca: "ocaApiKey" }
const BASE_URL_FIELDS: Record<string, string> = {
	openai: "openAiBaseUrl",
	"openai-compatible": "openAiBaseUrl",
	anthropic: "anthropicBaseUrl",
	ollama: "ollamaBaseUrl",
	lmstudio: "lmStudioBaseUrl",
	gemini: "geminiBaseUrl",
	litellm: "liteLlmBaseUrl",
	requesty: "requestyBaseUrl",
	asksage: "tasksageApiUrl",
	sapaicore: "sapAiCoreBaseUrl",
	dify: "difyBaseUrl",
	oca: "ocaBaseUrl",
	aihubmix: "aihubmixBaseUrl",
}
const isCompatible = (provider: string) => provider === "openai" || provider === "openai-compatible"
function validHttpUrl(value: string): boolean {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol)
	} catch {
		return false
	}
}
/** Keep each valid option. A value of the wrong type costs that value only. */
function validOptions(
	schema: { shape: object },
	options: RecordValue,
	provider: string,
	onInvalid: (field: string) => void,
): RecordValue {
	const fields = schema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>
	const allowed = providerOptionMappings[toSdkProviderId(provider)] ?? {}
	return Object.fromEntries(
		Object.entries(options).filter(([k, v]) => {
			if (!(k in fields) || !(k in allowed) || v === undefined) return false
			const valid = fields[k].safeParse(v).success
			if (!valid) onInvalid(k)
			return valid
		}),
	)
}

/** A failure whose message is safe to show. Anything else is reported by type alone. */
export class ModelSettingsMigrationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "ModelSettingsMigrationError"
	}
}
export function redactedMigrationCause(error: unknown): string {
	if (error instanceof ModelSettingsMigrationError) return error.message
	return `Unexpected ${error instanceof Error ? error.name : "failure"} while moving model settings`
}

export interface MigrationDependencies {
	state: ClineMemento
	secrets?: ConnectionSecretStore
	legacySecretKeys: readonly string[]
	readLegacySecret(key: string): string | undefined
	/** Caller owns an interprocess lock and reloads state before entering. */
	enabled?: boolean
	/** A function is only read when the migration actually runs. */
	sdkInput?: RecordValue | (() => Promise<RecordValue>)
}
export type MigrationResult = "disabled" | "complete"

/**
 * Journal order: immutable backup -> prepared -> copied/verified secrets -> target -> complete.
 * Runs until complete, always building from legacy state; after that the new settings are the user's and this
 * never reads or writes them again. Edits made in an older version after a downgrade aren't imported.
 */
export async function migrateModelSettings(deps: MigrationDependencies): Promise<MigrationResult> {
	if (!modelSettingsRolloutEnabled(deps.enabled)) return "disabled"
	const { state } = deps
	if (state.get<ModelSettingsMigration>("modelSettingsMigration")?.status === "complete") return "complete"
	const sdkInput = typeof deps.sdkInput === "function" ? await deps.sdkInput() : (deps.sdkInput ?? {})
	const raw = Object.fromEntries(
		state
			.keys()
			.filter(
				(k) =>
					(ApiHandlerSettingsKeys as readonly string[]).includes(k) ||
					[
						"apiConfigProfiles",
						"profiles",
						"modelProfiles",
						"askProfileId",
						"actProfileId",
						"profilesMigration",
						"threadSelectionStamp",
					].includes(k) ||
					/^(planMode|actMode|subagent|thread(Default|Separate|Ask|Act|Titles)|walkthroughGenerate)/.test(k),
			)
			.map((k) => [k, state.get(k)]),
	)
	const issues: ModelSettingsMigrationIssue[] = []
	const note = (kind: ModelSettingsMigrationIssue["kind"], field: string, source: string, ids: object = {}) =>
		issues.push({ kind, field, source, ...ids })

	const legacy = backupLegacy(raw)
	const sdkLegacy = backupSdk(sdkInput)
	const fingerprint = digest([legacy, sdkLegacy])
	const backupId = "settings-backup-v1"
	if (!state.get("modelSettingsBackupV1"))
		await state.update("modelSettingsBackupV1", {
			version: 1,
			backupId,
			createdAt: Date.now(),
			legacyFingerprint: fingerprint,
			legacy,
			sdkLegacy,
			secretKeys: [...deps.legacySecretKeys],
		})

	const listOf = (key: string, label: string): RecordValue[] => {
		const value = raw[key]
		if (value === undefined) return []
		if (!Array.isArray(value)) {
			note("dropped", key, label)
			return []
		}
		return value.flatMap((entry, index) => {
			const entryRecord = record(entry)
			if (!entryRecord) note("dropped", key, `${label} ${index + 1}`)
			return entryRecord ? [entryRecord] : []
		})
	}
	for (const file of (sdkInput.unreadable as string[] | undefined) ?? []) note("dropped", "settings", file)
	const savedConfigurations = listOf("apiConfigProfiles", "Saved configuration")
	const configurations: RecordValue[] = [...savedConfigurations]
	const profiles = listOf(raw.modelProfiles !== undefined ? "modelProfiles" : "profiles", "Saved profile")
	const secretFields = (sourceId: string, own: boolean, provider: string) => {
		const allowed = providerSecretFields(toSdkProviderId(provider))
		const stored = own
			? deps.legacySecretKeys
					.filter((k) => k.startsWith(`profile:${sourceId}:`))
					.map((k) => k.slice(`profile:${sourceId}:`.length))
			: [...SecretKeys]
		return stored.filter((k) => allowed.includes(k))
	}
	const readSecretField = (sourceId: string, own: boolean, field: string) =>
		deps.readLegacySecret(own ? `profile:${sourceId}:${field}` : field) || undefined

	let sdkDefault: string | undefined
	const sdkProviders = sdkInput.providers === undefined ? undefined : record(sdkInput.providers)
	if (sdkInput.providers !== undefined && !sdkProviders) note("dropped", "settings", "providers.json")
	for (const [provider, entry] of Object.entries(record(sdkProviders?.providers) ?? {})) {
		const saved = record(record(entry)?.settings)
		if (!saved) {
			note("dropped", "settings", `providers.json: ${provider}`)
			continue
		}
		if (!text(saved.model)) continue
		const sourceId = `sdk-${provider}`
		configurations.push({
			id: sourceId,
			name: provider,
			provider,
			modelId: saved.model,
			sdkAccount: true,
			options: { openAiBaseUrl: saved.baseUrl, openAiHeaders: saved.headers },
		})
		if (sdkProviders?.lastUsedProvider === provider) sdkDefault = sourceId
	}
	const sdkModelsFile = sdkInput.models === undefined ? undefined : record(sdkInput.models)
	if (sdkInput.models !== undefined && !sdkModelsFile) note("dropped", "settings", "models.json")
	const sdkModels = record(sdkModelsFile?.providers) ?? {}
	for (const [provider, entry] of Object.entries(sdkModels)) {
		const providerEntry = record(entry)
		if (!providerEntry) {
			note("dropped", "settings", `models.json: ${provider}`)
			continue
		}
		for (const modelId of Object.keys(record(providerEntry.models) ?? {})) {
			if (configurations.some((c) => toSdkProviderId(String(c.provider)) === provider && c.modelId === modelId)) continue
			configurations.push({
				id: `sdk-model-${provider}-${modelId}`,
				name: modelId,
				provider,
				modelId,
				sdkAccount: true,
				options: { openAiBaseUrl: record(providerEntry.provider)?.baseUrl },
			})
		}
	}
	// With no saved configurations legacy would capture each mode's flat selection into one, so it becomes a row.
	// Once any exist the flat values only mirror an assignment, and a row for them would be clutter.
	const flat: Partial<Record<"plan" | "act", string>> = {}
	if (!savedConfigurations.length) {
		for (const mode of ["act", "plan"] as const) {
			const provider = text(raw[`${mode}ModeApiProvider`] ?? raw.apiProvider)
			if (!provider) continue
			const modelId =
				text(raw[getProviderModelIdKey(provider, mode)] ?? raw.apiModelId) ??
				(isCompatible(provider) ? undefined : getProviderDefaultModelId(provider) || undefined)
			if (!modelId) continue
			const sameProvider = (c: RecordValue) => toSdkProviderId(String(c.provider)) === toSdkProviderId(provider)
			const account = configurations.find((c) => c.sdkAccount === true && sameProvider(c) && c.modelId === modelId)
			if (account && !secretFields("", false, provider).some((k) => readSecretField("", false, k))) {
				flat[mode] = String(account.id)
				continue
			}
			const act = configurations.find((c) => c.id === flat.act && c.mode === "act")
			if (
				mode === "plan" &&
				act &&
				sameProvider(act) &&
				act.modelId === modelId &&
				stable(legacyModelValues(raw, "plan")) === stable(legacyModelValues(raw, "act"))
			) {
				flat.plan = flat.act
				continue
			}
			flat[mode] = `legacy-${mode}`
			configurations.push({
				id: flat[mode],
				provider,
				modelId,
				options: raw,
				reasoningEffort: raw[`${mode}ModeReasoningEffort`],
				mode,
			})
		}
	}

	const settings = createDefaultModelSettings()
	const journal: ModelSettingsMigration = {
		version: 1,
		status: "prepared",
		backupId,
		configurationModels: {},
		profilePicks: {},
		legacyFingerprint: fingerprint,
	}
	const copies: Array<[string, string]> = []
	const picks: Record<string, ModelPick> = {}
	const rowLevels = new Map<string, ModelLevel[]>()
	const gateway = createGateway()
	const levelOn = (modelId: string, level: unknown): string => {
		const wanted = text(level)
		if (!wanted || wanted === "none") return "default"
		return closestOfferedLevel(rowLevels.get(modelId) ?? [], wanted)
	}

	const addConfiguration = (config: RecordValue, index: number) => {
		const provider = text(config.provider)
		const label = text(config.name) ?? text(config.id) ?? `Saved configuration ${index + 1}`
		if (!provider) {
			note("dropped", "provider", label)
			return
		}
		const sourceId = text(config.id) ?? `configuration-${index + 1}`
		const sdkProvider = toSdkProviderId(provider)
		const options = record(config.options) ?? {}
		const baseUrlField = config.sdkAccount === true ? "openAiBaseUrl" : BASE_URL_FIELDS[provider]
		const savedUrl = text(options[baseUrlField])?.trim() || undefined
		// A blank model means the provider's default. A catalog default means nothing on someone's own server,
		// so that, and having no default at all, is flagged for the user to fill in.
		const savedModelId = text(config.modelId)
		const upstreamId =
			savedModelId ??
			((isCompatible(provider) && savedUrl ? undefined : getProviderDefaultModelId(provider)) || MODEL_ID_NEEDED)
		const id = `legacy-${digest([sourceId, provider, upstreamId]).slice(0, 32)}`
		if (settings.models.some((m) => m.id === id)) return
		const connectionId = `${id}-connection`
		const flag = (kind: ModelSettingsMigrationIssue["kind"], field: string) =>
			note(kind, field, label, { modelId: id, connectionId })
		if (!savedModelId) flag("normalized", "modelId")
		if (config.options !== undefined && !record(config.options)) flag("dropped", "options")
		const mode = config.mode === "plan" ? "plan" : "act"
		const normalized = { ...options }
		for (const [key, value] of Object.entries(options))
			if (key.startsWith(`${mode}Mode`)) normalized[`actMode${key.slice(`${mode}Mode`.length)}`] = value

		let baseUrl: string | null = null
		if (savedUrl && validHttpUrl(savedUrl)) {
			baseUrl = savedUrl
			normalized[baseUrlField] = savedUrl
		} else if (savedUrl) {
			baseUrl = BASE_URL_NEEDED
			delete normalized[baseUrlField]
			flag("normalized", "baseUrl")
		}

		const prefix = `settings:v1:connection:${connectionId}:`
		const own = config.mode === undefined
		const secrets: Record<string, string> = {}
		const rowCopies: Array<[string, string]> = []
		for (const field of secretFields(sourceId, own, provider)) {
			if (field === ACCOUNT_TOKEN_FIELDS[provider]) continue
			const value = readSecretField(sourceId, own, field)
			if (value !== undefined) {
				secrets[field] = `${prefix}${field}`
				rowCopies.push([`${prefix}${field}`, value])
			}
		}
		const keyField = isCompatible(provider)
			? "openAiApiKey"
			: provider === "openai-native"
				? "openAiNativeApiKey"
				: provider === "anthropic"
					? "apiKey"
					: Object.keys(secrets).find((k) => /apiKey$/i.test(k))
		const keyRef = keyField ? secrets[keyField] : undefined
		// A compatible server with a URL and no key of its own runs keyless, as it does today. It never borrows one.
		const keylessServer = isCompatible(provider) && !!savedUrl

		const headers: Header[] = []
		// The flat store's headers belong to OpenAI Compatible. Another provider must never receive them.
		const savedHeaders = config.mode && !isCompatible(provider) ? undefined : options.openAiHeaders
		if (savedHeaders !== undefined && savedHeaders !== null && !record(savedHeaders)) flag("dropped", "headers")
		for (const [i, [rawName, rawValue]] of Object.entries(record(savedHeaders) ?? {}).entries()) {
			const name = rawName.trim()
			const value = String(rawValue).replace(/^[\r\n]+|[\r\n]+$/g, "")
			// The name may be a pasted credential, so only its position is recorded.
			if (
				!HEADER_NAME.test(name) ||
				/[\r\n]/.test(value) ||
				headers.some((h) => h.name.toLowerCase() === name.toLowerCase())
			) {
				flag("dropped", `header ${i + 1}`)
				continue
			}
			const headerId = `header-${i}`
			if (LOCKED_HEADER.test(name)) {
				const secretRef = `${prefix}${headerId}`
				rowCopies.push([secretRef, value])
				headers.push({ id: headerId, name, storage: "secret", secretRef })
			} else headers.push({ id: headerId, name, storage: "plain", value })
		}

		const connection: Connection = {
			id: connectionId,
			name: text(config.name) ?? (config.mode ? provider : upstreamId),
			baseUrl,
			auth:
				config.sdkAccount === true
					? { kind: "sdk-account", providerId: sdkProvider }
					: options.azureIdentity === true
						? { kind: "azure-identity" }
						: keyRef
							? { kind: "keychain", secretRef: keyRef }
							: ACCOUNT_PROVIDERS.includes(provider)
								? { kind: "sdk-account", providerId: sdkProvider }
								: NO_KEY_PROVIDERS.includes(provider) || keylessServer
									? { kind: "none" }
									: { kind: "keychain", secretRef: `${prefix}${keyField ?? "apiKey"}` },
			headers,
			requestTimeoutMs: null,
			defaults: {},
			...(isCompatible(provider)
				? {
						kind: "openai-compatible" as const,
						apiFormat:
							(config.openAiCompatibleApiType ?? options.openAiCompatibleApiType) === "responses"
								? ("responses" as const)
								: ("chat" as const),
						azureApiVersion: text(options.azureApiVersion) ?? null,
					}
				: {
						kind: "provider" as const,
						providerId: sdkProvider,
						options: validOptions(ConnectionOptionsSchema, normalized, provider, (f) => flag("dropped", f)),
						secretRefs: Object.fromEntries(Object.entries(secrets).filter(([k]) => k !== keyField)),
					}),
		}

		const sdkEntry = record(sdkModels[sdkProvider])
		const sdkInfo = record(record(sdkEntry?.models)?.[upstreamId])
		const sdkValues = sdkInfo ? sdkModelValues(sdkInfo, (f) => flag("normalized", f)) : {}
		const legacyValues = legacyModelValues(options, mode, (f) => flag("normalized", f))
		const effort = text(config.reasoningEffort)
		const profileEfforts = profiles.filter((p) => p.configurationId === sourceId).map((p) => text(p.reasoningEffort))
		const thinkingLevel = text(options[`gemini${mode === "plan" ? "Plan" : "Act"}ModeThinkingLevel`])
		const catalogModel = gateway.listModels(sdkProvider).find((m) => m.id === upstreamId)
		const catalogLevels = catalogModel ? catalogReasoningLevels(catalogModel) : undefined
		const reasoning = legacyValues.reasoning ?? sdkValues.reasoning
		const levels = migratedLevels({
			advertised: sdkValues.levels ?? catalogLevels,
			withoutReasoning: reasoning === "no" || (!!catalogModel && !catalogLevels && reasoning !== "yes"),
			savedEfforts: [effort, ...profileEfforts].filter((e): e is string => !!e && e !== "none"),
			thinkingLevel,
		})
		const { levels: _sdkLevels, ...sdkRest } = sdkValues
		const row: ModelRow = {
			id,
			connectionId,
			upstreamId,
			name: text(config.name) ?? (sdkInfo ? text(sdkInfo.name) : undefined) ?? "",
			kind: sdkInfo?.operation && sdkInfo.operation !== "language" ? "non-chat" : "unknown",
			overrides: {
				...sdkRest,
				...legacyValues,
				...(levels.length > 1 ? { levels, reasoning: "yes" as const } : {}),
			},
			...(levels.length > 1 ? { migratedValues: ["levels" as const, "reasoning" as const] } : {}),
			legacyMetadata: {
				source: "legacy",
				...(sdkInfo ? { sdk: withoutSecretNames(sdkInfo) as Record<string, Json> } : {}),
				modelInfo: withoutSecretNames(
					Object.entries(options).find(
						([k, v]) => k.startsWith(`${mode}Mode`) && k.endsWith("ModelInfo") && v && typeof v === "object",
					)?.[1] ?? {},
				) as Record<string, Json>,
			},
			providerOptions: validOptions(ModelProviderOptionsSchema, normalized, provider, (f) => flag("dropped", f)),
		}
		if (!ConnectionSchema.safeParse(connection).success) {
			note("dropped", "connection", label)
			return
		}
		if (!ModelRowSchema.safeParse(row).success) {
			delete row.legacyMetadata
			flag("dropped", "metadata")
			if (!ModelRowSchema.safeParse(row).success) {
				note("dropped", "model", label)
				return
			}
		}
		copies.push(...rowCopies)
		settings.connections.push(connection)
		settings.models.push(row)
		rowLevels.set(id, levels)
		journal.configurationModels[sourceId] ??= id
		picks[sourceId] = { modelId: id, levelId: levelOn(id, effort ?? thinkingLevel) }
	}
	configurations.forEach(addConfiguration)

	for (const [index, p] of profiles.entries()) {
		const id = text(p.id)
		const configurationId = text(p.configurationId)
		if (!id || !configurationId) {
			note("dropped", "profile", text(p.name) ?? `Saved profile ${index + 1}`)
			continue
		}
		const modelId = journal.configurationModels[configurationId]
		journal.profilePicks[id] ??= modelId
			? { modelId, levelId: levelOn(modelId, p.reasoningEffort) }
			: {
					modelId: `missing:${configurationId}`,
					levelId: !p.reasoningEffort || p.reasoningEffort === "none" ? "default" : String(p.reasoningEffort),
				}
	}
	const pick = (ref: unknown): ModelPick | null =>
		typeof ref === "string"
			? (journal.profilePicks[ref] ?? picks[ref] ?? { modelId: `missing:${ref}`, levelId: "default" })
			: null
	const savedIds = new Set(savedConfigurations.map((c) => text(c.id)).filter((id) => id && picks[id]))
	const healedConfiguration = (
		savedConfigurations.find((c) => savedIds.has(text(c.id)) && isAllowedApiProvider(text(c.provider))) ??
		savedConfigurations.find((c) => savedIds.has(text(c.id)))
	)?.id
	const separate = raw.threadSeparateAskActProfiles === true
	/**
	 * What legacy runs in a mode: the thread default profile (modelProfiles.ts), else the assigned configuration at
	 * the global effort, else the one ensureApiConfigProfiles assigns, else the flat selection or SDK account.
	 * `explicit` is whether the level was actually chosen, rather than an effort nobody set.
	 */
	const effectiveSelection = (mode: "plan" | "act"): { pick: ModelPick | null; explicit: boolean } => {
		const defaultRef = separate
			? (raw[mode === "plan" ? "threadAskProfileId" : "threadActProfileId"] ?? raw.threadDefaultProfileId)
			: raw.threadDefaultProfileId
		const threadDefault = typeof defaultRef === "string" ? journal.profilePicks[defaultRef] : undefined
		if (threadDefault && !threadDefault.modelId.startsWith("missing:")) return { pick: threadDefault, explicit: true }
		const effort = text(raw[`${mode}ModeReasoningEffort`])
		const explicit = !!effort && effort !== "none"
		const assigned = text(raw[mode === "plan" ? "askProfileId" : "actProfileId"])
		if (assigned && savedIds.has(assigned)) {
			const modelId = picks[assigned].modelId
			return { pick: { modelId, levelId: levelOn(modelId, effort) }, explicit }
		}
		if (healedConfiguration) return { pick: picks[String(healedConfiguration)], explicit: false }
		const flatId = flat[mode]
		if (flatId && picks[flatId]) {
			const modelId = picks[flatId].modelId
			return { pick: { modelId, levelId: levelOn(modelId, effort) }, explicit }
		}
		if (sdkDefault && picks[sdkDefault]) return { pick: picks[sdkDefault], explicit: false }
		return { pick: pick(defaultRef ?? assigned), explicit: false }
	}
	const chat = effectiveSelection("act")
	const ask = effectiveSelection("plan")
	settings.roles.chat = chat.pick
	const differentAsk =
		!!ask.pick &&
		(ask.pick.modelId !== chat.pick?.modelId || (ask.pick.levelId !== chat.pick.levelId && ask.explicit && chat.explicit))
	settings.roles.ask = { enabled: differentAsk, pick: differentAsk ? ask.pick : chat.pick }
	const titles = pick(raw.threadTitlesModelProfileId ?? raw.threadTitlesProfileId)
	const generate = pick(raw.walkthroughGenerateModelProfileId ?? raw.walkthroughGenerateProfileId)
	settings.roles.background = {
		pick: titles ?? generate ?? settings.roles.chat,
		titlesEnabled: raw.threadTitlesEnabled === true,
		overrides: {},
	}
	if (!titles && settings.roles.chat && JSON.stringify(settings.roles.background.pick) !== JSON.stringify(settings.roles.chat))
		settings.roles.background.overrides.titles = settings.roles.chat
	if (generate) settings.roles.background.overrides.generate = generate
	if (settings.roles.chat) settings.roles.background.overrides.commitMessages = settings.roles.chat
	settings.subagents.enabled = raw.subagentsEnabled !== false
	const cap = raw.subagentsMaxConcurrent
	if (cap !== undefined && (!Number.isInteger(cap) || (cap as number) < 0))
		note("normalized", "subagentsMaxConcurrent", "Subagents")
	settings.subagents.maxConcurrent = Number.isInteger(cap) && (cap as number) >= 0 ? (cap as number) : 3
	settings.subagents.access = {
		write: raw.subagentsAllowWrite !== false,
		commands: raw.subagentsAllowCommands !== false,
		web: raw.subagentsAllowWeb !== false,
		mcp: raw.subagentsAllowMcp !== false,
	}
	const subagent = pick(raw.subagentDefaultModelProfileId ?? raw.subagentDefaultProfileId)
	if (raw.subagentProfilesEnabled === true && subagent) settings.roles.subagents = { kind: "model", pick: subagent }
	else if (text(raw.subagentReasoningEffort) && raw.subagentReasoningEffort !== "none")
		settings.roles.subagents = { kind: "thread", level: String(raw.subagentReasoningEffort) }
	const allowed = raw.subagentAllowedModelProfileIds ?? raw.subagentAllowedProfileIds ?? []
	if (!Array.isArray(allowed)) note("dropped", "subagentAllowedModelProfileIds", "Subagents")
	for (const ref of Array.isArray(allowed) ? allowed : []) {
		if (ref === "parent") {
			settings.subagents.allowed.push({ kind: "thread", levels: ["inherit"] })
			continue
		}
		const selected = pick(ref)
		if (!selected) continue
		const entry = settings.subagents.allowed.find((a) => a.kind === "model" && a.modelId === selected.modelId)
		if (entry) {
			if (!entry.levels.includes(selected.levelId)) entry.levels.push(selected.levelId)
		} else settings.subagents.allowed.push({ kind: "model", modelId: selected.modelId, levels: [selected.levelId] })
	}
	// Only roles need a row to point at. An old thread naming a deleted profile stays an explicit unavailable pick.
	const referenced = [
		settings.roles.chat,
		settings.roles.ask.pick,
		settings.roles.background.pick,
		...Object.values(settings.roles.background.overrides),
		...(settings.roles.subagents.kind === "model" ? [settings.roles.subagents.pick] : []),
		...settings.subagents.allowed.flatMap((a) =>
			a.kind === "model" ? a.levels.map((levelId) => ({ modelId: a.modelId, levelId })) : [],
		),
	]
	for (const p of referenced) {
		if (!p || settings.models.some((m) => m.id === p.modelId)) continue
		const connectionId = `unavailable-${digest(p.modelId).slice(0, 24)}`
		settings.connections.push({
			id: connectionId,
			name: "Unavailable legacy connection",
			kind: "provider",
			providerId: "unavailable-legacy",
			baseUrl: null,
			auth: { kind: "keychain", secretRef: `settings:v1:connection:${connectionId}:apiKey` },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			options: {},
			secretRefs: {},
		})
		settings.models.push({
			id: p.modelId,
			name: "Unavailable saved model",
			upstreamId: p.modelId,
			connectionId,
			kind: "unknown",
			providerOptions: {},
			overrides: {
				...(p.levelId !== "default"
					? {
							reasoning: "yes",
							levels: [{ id: p.levelId, label: p.levelId, rank: 0, request: { kind: "effort", value: p.levelId } }],
						}
					: {}),
			},
		})
	}
	// Compare resolved credentials only in memory. Missing keys must never establish identity.
	const readSecret = (ref: string) => copies.find(([key]) => key === ref)?.[1]
	const identity = (c: Connection) => {
		const auth = c.auth.kind === "keychain" ? { kind: "keychain", value: readSecret(c.auth.secretRef) } : c.auth
		if (auth.kind === "keychain" && !("value" in auth && auth.value)) return undefined
		const headers = c.headers.map((h) => [h.name.toLowerCase(), h.storage === "plain" ? h.value : readSecret(h.secretRef)])
		const credentials =
			c.kind === "provider" ? Object.fromEntries(Object.entries(c.secretRefs).map(([k, ref]) => [k, readSecret(ref)])) : {}
		return stable({
			kind: c.kind,
			provider: c.kind === "provider" ? c.providerId : "openai-compatible",
			baseUrl: c.baseUrl,
			auth,
			headers: headers.sort(),
			credentials,
			options: c.kind === "provider" ? c.options : { apiFormat: c.apiFormat, azureApiVersion: c.azureApiVersion },
		})
	}
	const groups = new Map<string, Connection>()
	for (const connection of [...settings.connections]) {
		const key = identity(connection)
		if (key === undefined) continue
		const prior = groups.get(key)
		if (!prior) {
			groups.set(key, connection)
			continue
		}
		for (const model of settings.models) if (model.connectionId === connection.id) model.connectionId = prior.id
		for (const issue of issues) if (issue.connectionId === connection.id) issue.connectionId = prior.id
		settings.connections = settings.connections.filter((c) => c.id !== connection.id)
	}
	for (const connection of settings.connections) {
		const rows = settings.models.filter((m) => m.connectionId === connection.id)
		if (rows.length < 2) continue
		for (const key of Object.keys(rows[0].overrides) as Array<keyof (typeof rows)[0]["overrides"]>) {
			const value = rows[0].overrides[key]
			if (value === undefined || !rows.every((m) => stable(m.overrides[key]) === stable(value))) continue
			Object.assign(connection.defaults, { [key]: value })
			for (const row of rows) {
				delete row.overrides[key]
				row.migratedValues = row.migratedValues?.filter((migrated) => migrated !== key)
				if (!row.migratedValues?.length) delete row.migratedValues
			}
		}
	}
	const parsed = ModelSettingsSchema.safeParse(settings)
	if (!parsed.success) {
		// Paths and messages only: zod issues never carry the rejected input here, and paths name fields, not values.
		const where = [...new Set(parsed.error.issues.map((issue) => issue.path.slice(0, 2).join(".") || issue.message))]
		throw new ModelSettingsMigrationError(`Moved settings failed validation at ${where.slice(0, 5).join(", ")}`)
	}
	if (issues.length) journal.issues = issues
	await state.update("modelSettingsMigration", journal)
	if (copies.length && !deps.secrets)
		throw new ModelSettingsMigrationError("Connection keychain is unavailable; migration will retry")
	for (const [ref, value] of copies) {
		try {
			await deps.secrets!.set(ref, value)
		} catch (error) {
			throw new ModelSettingsMigrationError("Could not write to the connection keychain", { cause: error })
		}
		if ((await deps.secrets!.get(ref)) !== value)
			throw new ModelSettingsMigrationError("Connection keychain verification failed")
	}
	await state.update("modelSettings", settings)
	await state.update("modelSettingsMigration", { ...journal, status: "complete", completedAt: Date.now() })
	return "complete"
}
