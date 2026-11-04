import { createHash } from "node:crypto"
import {
	BUILTIN_MODEL_VALUES,
	type Connection,
	ConnectionOptionsSchema,
	createDefaultModelSettings,
	type ModelPick,
	ModelProviderOptionsSchema,
	type ModelSettings,
	type ModelSettingsMigration,
	ModelSettingsSchema,
} from "@shared/model-settings"
import type { ClineMemento } from "@shared/storage/ClineStorage"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import { ApiHandlerSettingsKeys, SecretKeys } from "@shared/storage/state-keys"
import { toSdkProviderId } from "@/sdk/model-catalog/sdk-provider-id"
import type { ConnectionSecretStore } from "@/sdk/model-settings/connection-secret-store"
import { legacyModelValues, sdkModelValues } from "@/sdk/model-settings/legacy-values"
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
const object = (v: unknown): RecordValue => {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid legacy settings object")
	return v as RecordValue
}
const list = (v: unknown): RecordValue[] => {
	if (v === undefined) return []
	if (!Array.isArray(v)) throw new Error("Invalid legacy profile array")
	return v.map(object)
}
const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex")
// Secrets are retained in their original store, never in backup metadata or fingerprints.
function nonsecret(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(nonsecret)
	if (v && typeof v === "object")
		return Object.fromEntries(
			Object.entries(v)
				.filter(([k]) => !/secret|token(?!s$)|api.?key|password|credential|authorization/i.test(k))
				.map(([k, x]) => [k, nonsecret(x)]),
		)
	return v
}
export interface MigrationDependencies {
	state: ClineMemento
	secrets?: ConnectionSecretStore
	legacySecretKeys: readonly string[]
	readLegacySecret(key: string): string | undefined
	/** Caller owns an interprocess lock and reloads state before entering. */
	enabled?: boolean
	sdkInput?: Record<string, unknown>
}
export type MigrationResult = "disabled" | "complete"

/** Journal order: immutable backup -> prepared -> copied/verified secrets -> target -> complete. */
export async function migrateModelSettings(deps: MigrationDependencies): Promise<MigrationResult> {
	if (!modelSettingsRolloutEnabled(deps.enabled)) return "disabled"
	const { state } = deps
	const previous = state.get<ModelSettingsMigration>("modelSettingsMigration")
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
	const legacy = nonsecret(raw) as RecordValue
	const fingerprint = digest([legacy, nonsecret(deps.sdkInput ?? {})])
	const existing = state.get<ModelSettings>("modelSettings")
	const backupId = "settings-backup-v1"
	if (!state.get("modelSettingsBackupV1"))
		await state.update("modelSettingsBackupV1", {
			version: 1,
			backupId,
			createdAt: Date.now(),
			legacyFingerprint: fingerprint,
			legacy,
			sdkLegacy: nonsecret(deps.sdkInput ?? {}),
			secretKeys: [...deps.legacySecretKeys],
		})
	const configurations = list(raw.apiConfigProfiles)
	const profiles = list(raw.modelProfiles ?? raw.profiles)
	let sdkDefault: string | undefined
	if (deps.sdkInput?.providers) {
		const sdk = object(deps.sdkInput.providers)
		for (const [provider, entry] of Object.entries(object(sdk.providers ?? {}))) {
			const saved = object(object(entry).settings)
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
			if (sdk.lastUsedProvider === provider) sdkDefault = sourceId
		}
	}
	const sdkModels = deps.sdkInput?.models ? object(object(deps.sdkInput.models).providers ?? {}) : {}
	for (const [provider, entry] of Object.entries(sdkModels)) {
		const record = object(entry)
		for (const modelId of Object.keys(object(record.models ?? {}))) {
			if (configurations.some((c) => toSdkProviderId(String(c.provider)) === provider && c.modelId === modelId)) continue
			configurations.push({
				id: `sdk-model-${provider}-${modelId}`,
				name: modelId,
				provider,
				modelId,
				sdkAccount: true,
				options: { openAiBaseUrl: record.provider ? object(record.provider).baseUrl : undefined },
			})
		}
	}
	for (const mode of ["plan", "act"] as const) {
		const provider = text(raw[`${mode}ModeApiProvider`] ?? raw.apiProvider)
		if (!provider) continue
		const modelId = text(raw[getProviderModelIdKey(provider, mode)] ?? raw.apiModelId)
		if (modelId)
			configurations.push({
				id: `legacy-${mode}`,
				name: `Previous ${mode === "plan" ? "Ask" : "Act"}`,
				provider,
				modelId,
				options: raw,
				reasoningEffort: raw[`${mode}ModeReasoningEffort`],
				mode,
			})
	}
	const settings = existing ? ModelSettingsSchema.parse(existing) : createDefaultModelSettings()
	const journal: ModelSettingsMigration = {
		version: 1,
		status: "prepared",
		backupId,
		configurationModels: { ...previous?.configurationModels },
		profilePicks: { ...previous?.profilePicks },
		legacyFingerprint: fingerprint,
	}
	const copies: Array<[string, string]> = []
	const picks: Record<string, ModelPick> = {}
	for (const config of configurations) {
		const sourceId = text(config.id)
		const provider = text(config.provider)
		const upstreamId = text(config.modelId)
		if (!sourceId || !provider || !upstreamId) throw new Error("Invalid saved configuration identity")
		const sdkEntry = sdkModels[toSdkProviderId(provider)]
		const sdkInfo = sdkEntry ? object(object(sdkEntry).models ?? {})[upstreamId] : undefined
		// Include nonsecret content to import changed configurations after downgrade without replacing new rows.
		let id = `legacy-${digest([
			sourceId,
			nonsecret(config),
			nonsecret(sdkInfo),
			profiles
				.filter((p) => p.configurationId === sourceId)
				.map((p) => p.reasoningEffort)
				.sort(),
		]).slice(0, 32)}`
		// Credential revisions are numbered from persisted rows, never derived from a secret.
		const baseId = id
		const allowedSecrets = providerSecretFields(toSdkProviderId(provider))
		const sourceFields = (
			config.mode === undefined
				? deps.legacySecretKeys
						.filter((k) => k.startsWith(`profile:${sourceId}:`))
						.map((k) => k.slice(`profile:${sourceId}:`.length))
				: [...SecretKeys]
		).filter((k) => allowedSecrets.includes(k))
		const credentialValues = Object.fromEntries(
			sourceFields
				.map((k) => [k, deps.readLegacySecret(config.mode === undefined ? `profile:${sourceId}:${k}` : k)])
				.filter(([, v]) => v !== undefined),
		)
		let revision = 0
		while (settings.models.some((m) => m.id === id)) {
			const row = settings.models.find((m) => m.id === id)!
			const old = settings.connections.find((c) => c.id === row.connectionId)!
			const refs = old.kind === "provider" ? { ...old.secretRefs } : {}
			if (old.auth.kind === "keychain") refs[old.auth.secretRef.split(":").at(-1)!] = old.auth.secretRef
			const saved = Object.fromEntries(
				await Promise.all(Object.entries(refs).map(async ([k, ref]) => [k, await deps.secrets?.get(ref)])),
			)
			const oldHeaders = await Promise.all(
				old.headers.map(async (h) => [
					h.name.toLowerCase(),
					h.storage === "plain" ? h.value : await deps.secrets?.get(h.secretRef),
				]),
			)
			const configOptions = config.options === undefined ? {} : object(config.options)
			const newHeaders = Object.entries(object(configOptions.openAiHeaders ?? {})).map(([name, value]) => [
				name.toLowerCase(),
				String(value),
			])
			if (stable(saved) === stable(credentialValues) && stable(oldHeaders.sort()) === stable(newHeaders.sort())) break
			id = `${baseId}-credentials-${++revision}`
		}
		const connectionId = `${id}-connection`
		const options = config.options === undefined ? {} : object(config.options)
		const mode = config.mode === "plan" ? "plan" : "act"
		const normalized = { ...options }
		for (const [key, value] of Object.entries(options))
			if (key.startsWith(`${mode}Mode`)) normalized[`actMode${key.slice(`${mode}Mode`.length)}`] = value
		const baseUrlFields: Record<string, string> = {
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
		const baseUrl = text(options[config.sdkAccount === true ? "openAiBaseUrl" : baseUrlFields[provider]]) ?? null
		const prefix = `settings:v1:connection:${connectionId}:`
		const own = config.mode === undefined
		const fields = (
			own
				? deps.legacySecretKeys
						.filter((k) => k.startsWith(`profile:${sourceId}:`))
						.map((k) => k.slice(`profile:${sourceId}:`.length))
				: [...SecretKeys]
		).filter((k) => allowedSecrets.includes(k))
		const secrets: Record<string, string> = {}
		for (const field of fields) {
			const value = deps.readLegacySecret(own ? `profile:${sourceId}:${field}` : field)
			if (value !== undefined) {
				secrets[field] = `${prefix}${field}`
				if (previous?.status !== "complete" || !settings.models.some((m) => m.id === id))
					copies.push([`${prefix}${field}`, value])
			}
		}
		const keyField =
			provider === "openai" || provider === "openai-compatible"
				? "openAiApiKey"
				: provider === "openai-native"
					? "openAiNativeApiKey"
					: provider === "anthropic"
						? "apiKey"
						: Object.keys(secrets).find((k) => /apiKey$/i.test(k))
		const keyRef = keyField ? secrets[keyField] : undefined
		const connection: Connection = {
			id: connectionId,
			name: text(config.name) ?? upstreamId,
			baseUrl,
			auth:
				config.sdkAccount === true
					? { kind: "sdk-account", providerId: toSdkProviderId(provider) }
					: options.azureIdentity === true
						? { kind: "azure-identity" }
						: keyRef
							? { kind: "keychain", secretRef: keyRef }
							: provider === "ollama" ||
									provider === "lmstudio" ||
									["bedrock", "vertex", "claude-code", "qwen-code", "openai-codex", "opencode"].includes(
										provider,
									)
								? { kind: "none" }
								: { kind: "keychain", secretRef: `${prefix}${keyField ?? "apiKey"}` },
			headers: Object.entries(object(options.openAiHeaders ?? {})).map(([name, value], i) => {
				const headerId = `header-${i}`
				if (/authorization|api.?key|token|secret/i.test(name)) {
					const secretRef = `${prefix}${headerId}`
					if (previous?.status !== "complete" || !settings.models.some((m) => m.id === id))
						copies.push([secretRef, String(value)])
					return { id: headerId, name, storage: "secret" as const, secretRef }
				}
				return { id: headerId, name, storage: "plain" as const, value: String(value) }
			}),
			requestTimeoutMs: null,
			defaults: {},
			...(provider === "openai" || provider === "openai-compatible"
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
						providerId: toSdkProviderId(provider),
						options: ConnectionOptionsSchema.parse(
							Object.fromEntries(
								Object.entries(normalized).filter(
									([k]) =>
										k in ConnectionOptionsSchema.shape &&
										k in (providerOptionMappings[toSdkProviderId(provider)] ?? {}),
								),
							),
						),
						secretRefs: Object.fromEntries(Object.entries(secrets).filter(([k]) => k !== keyField)),
					}),
		}
		const effort = text(config.reasoningEffort)
		const thinkingLevel = text(options[`gemini${mode === "plan" ? "Plan" : "Act"}ModeThinkingLevel`])
		const levels = [
			{
				id: "default",
				label: "Default",
				rank: 0,
				request: thinkingLevel ? { kind: "thinking-level" as const, value: thinkingLevel } : { kind: "default" as const },
			},
			...Array.from(
				new Set([effort, ...profiles.filter((p) => p.configurationId === sourceId).map((p) => text(p.reasoningEffort))]),
			)
				.filter((e): e is string => !!e && e !== "none")
				.map((e, i) => ({ id: e, label: e, rank: i + 1, request: { kind: "effort" as const, value: e } })),
		]
		if (!settings.models.some((m) => m.id === id)) {
			settings.connections.push(connection)
			settings.models.push({
				id,
				connectionId,
				upstreamId,
				name: text(config.name) ?? (sdkInfo ? text(object(sdkInfo).name) : undefined) ?? "",
				kind: sdkInfo && object(sdkInfo).operation && object(sdkInfo).operation !== "language" ? "non-chat" : "unknown",
				overrides: {
					...(sdkInfo ? sdkModelValues(object(sdkInfo)) : {}),
					...legacyModelValues(options, mode),
					levels,
					...(levels.length > 1 || thinkingLevel ? { reasoning: "yes" } : {}),
				},
				providerOptions: ModelProviderOptionsSchema.parse(
					Object.fromEntries(
						Object.entries(normalized).filter(
							([k]) =>
								k in ModelProviderOptionsSchema.shape &&
								k in (providerOptionMappings[toSdkProviderId(provider)] ?? {}),
						),
					),
				),
			})
		}
		journal.configurationModels[sourceId] ??= id
		picks[sourceId] = { modelId: id, levelId: !effort || effort === "none" ? "default" : effort }
	}
	for (const p of profiles) {
		const id = text(p.id)
		if (!id || !text(p.configurationId)) throw new Error("Invalid model profile")
		journal.profilePicks[id] ??= {
			modelId: journal.configurationModels[String(p.configurationId)] ?? `missing:${p.configurationId}`,
			levelId: !p.reasoningEffort || p.reasoningEffort === "none" ? "default" : String(p.reasoningEffort),
		}
	}
	const pick = (ref: unknown): ModelPick | null =>
		typeof ref === "string"
			? (journal.profilePicks[ref] ?? picks[ref] ?? { modelId: `missing:${ref}`, levelId: "default" })
			: null
	if (!existing) {
		const separate = raw.threadSeparateAskActProfiles === true
		settings.roles.chat =
			pick(separate ? (raw.threadActProfileId ?? raw.actProfileId) : (raw.threadDefaultProfileId ?? raw.actProfileId)) ??
			picks["legacy-act"] ??
			(sdkDefault ? picks[sdkDefault] : null) ??
			null
		const ask =
			pick(separate ? (raw.threadAskProfileId ?? raw.askProfileId) : raw.askProfileId) ?? picks["legacy-plan"] ?? null
		settings.roles.ask = { enabled: separate || JSON.stringify(ask) !== JSON.stringify(settings.roles.chat), pick: ask }
		const titles = pick(raw.threadTitlesModelProfileId ?? raw.threadTitlesProfileId)
		const generate = pick(raw.walkthroughGenerateModelProfileId ?? raw.walkthroughGenerateProfileId)
		settings.roles.background = {
			pick: titles ?? generate ?? settings.roles.chat,
			titlesEnabled: raw.threadTitlesEnabled === true,
			overrides: {},
		}
		if (
			!titles &&
			settings.roles.chat &&
			JSON.stringify(settings.roles.background.pick) !== JSON.stringify(settings.roles.chat)
		)
			settings.roles.background.overrides.titles = settings.roles.chat
		if (generate) settings.roles.background.overrides.generate = generate
		if (settings.roles.chat) settings.roles.background.overrides.commitMessages = settings.roles.chat
		settings.subagents.enabled = raw.subagentsEnabled !== false
		settings.subagents.maxConcurrent = typeof raw.subagentsMaxConcurrent === "number" ? raw.subagentsMaxConcurrent : 3
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
		if (!Array.isArray(allowed)) throw new Error("Invalid allowed profiles")
		for (const ref of allowed) {
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
	}
	const referenced = [
		...Object.values(journal.profilePicks),
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
	const readSecret = async (ref: string) =>
		[...copies].reverse().find(([key]) => key === ref)?.[1] ?? (await deps.secrets?.get(ref))
	const identity = async (c: Connection) => {
		const auth = c.auth.kind === "keychain" ? { kind: "keychain", value: await readSecret(c.auth.secretRef) } : c.auth
		if (auth.kind === "keychain" && !("value" in auth && auth.value)) return undefined
		const headers = await Promise.all(
			c.headers.map(async (h) => [h.name.toLowerCase(), h.storage === "plain" ? h.value : await readSecret(h.secretRef)]),
		)
		const credentials =
			c.kind === "provider"
				? Object.fromEntries(
						await Promise.all(Object.entries(c.secretRefs).map(async ([k, ref]) => [k, await readSecret(ref)])),
					)
				: {}
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
		const key = await identity(connection)
		if (key === undefined) continue
		const prior = groups.get(key)
		if (!prior) {
			groups.set(key, connection)
			continue
		}
		for (const model of settings.models)
			if (model.connectionId === connection.id) {
				for (const field of Object.keys(prior.defaults) as Array<keyof typeof prior.defaults>) {
					if (model.overrides[field] === undefined)
						Object.assign(model.overrides, { [field]: connection.defaults[field] ?? BUILTIN_MODEL_VALUES[field] })
				}
				model.connectionId = prior.id
			}
		settings.connections = settings.connections.filter((c) => c.id !== connection.id)
	}
	// Only new connections acquire common defaults; never rewrite authored defaults on reactivation.
	for (const connection of settings.connections) {
		if (existing?.connections.some((c) => c.id === connection.id)) continue
		const rows = settings.models.filter((m) => m.connectionId === connection.id)
		if (rows.length < 2) continue
		for (const key of Object.keys(rows[0].overrides) as Array<keyof (typeof rows)[0]["overrides"]>) {
			const value = rows[0].overrides[key]
			if (value === undefined || !rows.every((m) => stable(m.overrides[key]) === stable(value))) continue
			Object.assign(connection.defaults, { [key]: value })
			for (const row of rows) delete row.overrides[key]
		}
	}
	ModelSettingsSchema.parse(settings)
	if (previous?.status === "complete" && previous.legacyFingerprint === fingerprint && stable(existing) === stable(settings))
		return "complete"
	await state.update("modelSettingsMigration", journal)
	if (copies.length && !deps.secrets) throw new Error("Connection keychain is unavailable; migration will retry")
	for (const [ref, value] of copies) {
		await deps.secrets!.set(ref, value)
		if ((await deps.secrets!.get(ref)) !== value) throw new Error("Connection keychain verification failed")
	}
	await state.update("modelSettings", settings)
	await state.update("modelSettingsMigration", { ...journal, status: "complete", completedAt: Date.now() })
	return "complete"
}
