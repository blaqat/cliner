import { randomUUID } from "node:crypto"
import type { ApiConfiguration, ApiProvider } from "@shared/api"
import { type ApiConfigProfile, isAllowedApiProvider, type OpenAiCompatibleApiType } from "@shared/api-profiles"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import {
	ApiHandlerSettingsKeys,
	isSecretKey,
	isSettingsKey,
	type SecretKey,
	SecretKeys,
	type Secrets,
	type SettingsKey,
} from "@shared/storage/state-keys"
import { isOpenaiReasoningEffort, type Mode } from "@shared/storage/types"
import type { StateManager } from "@/core/storage/StateManager"

/**
 * Saved API configuration profiles (plan §1b).
 *
 * Profiles live in the `apiConfigProfiles` global-state key; the per-mode
 * assignments live in `askProfileId` / `actProfileId` (plan keys serve Ask).
 * Secrets are stored per profile in secret storage under
 * `profile:<id>:<secretKey>` so switching profiles rotates credentials too.
 * `assignApiProfile` writes provider/model keys per mode. Connection fields
 * resolve from the assigned profile when StateManager reads configuration.
 */

/** Non-secret option fields captured per provider on save/migration. */
const PROFILE_PROVIDER_OPTION_KEYS: Partial<Record<ApiProvider, readonly SettingsKey[]>> = {
	anthropic: ["anthropicBaseUrl"],
	openai: ["openAiBaseUrl", "openAiHeaders", "azureApiVersion", "azureIdentity"],
	"openai-native": [],
	bedrock: [
		"awsRegion",
		"awsAuthentication",
		"awsUseProfile",
		"awsProfile",
		"awsBedrockEndpoint",
		"awsUseCrossRegionInference",
		"awsUseGlobalInference",
		"awsBedrockUsePromptCache",
	],
}

/** Provider-level secret fields copied into a profile's secret scope. */
const PROFILE_PROVIDER_SECRET_KEYS: Partial<Record<ApiProvider, readonly SecretKey[]>> = {
	anthropic: ["apiKey"],
	openai: ["openAiApiKey"],
	"openai-native": ["openAiNativeApiKey"],
	bedrock: ["awsAccessKey", "awsSecretKey", "awsSessionToken", "awsBedrockApiKey"],
}

/** Extra mode-specific fields worth snapshotting per provider. */
const PROFILE_PROVIDER_MODE_KEYS: Partial<Record<ApiProvider, readonly string[]>> = {
	openai: ["OpenAiModelInfo"],
	bedrock: ["AwsBedrockCustomSelected", "AwsBedrockCustomModelBaseId"],
}

/**
 * Minimal storage surface the profile helpers need — implemented by
 * StateManager, trivially faked in unit tests.
 */
export interface ApiProfileStore {
	getGlobalStateKey: StateManager["getGlobalStateKey"]
	setGlobalStateBatch: StateManager["setGlobalStateBatch"]
	getApiConfiguration: StateManager["getApiConfiguration"]
	setApiConfiguration: StateManager["setApiConfiguration"]
	getSecretForKey: StateManager["getSecretForKey"]
	setSecretsForKeys: StateManager["setSecretsForKeys"]
	listSecretStorageKeys: StateManager["listSecretStorageKeys"]
}

const PROFILE_PROVIDER_NAMES: Partial<Record<ApiProvider, string>> = {
	anthropic: "Anthropic",
	openai: "OpenAI Compatible",
	"openai-native": "OpenAI",
	bedrock: "AWS Bedrock",
}

export function profileSecretStorageKey(profileId: string, secretKey: string): string {
	return `profile:${profileId}:${secretKey}`
}

export function readApiConfigProfiles(stateManager: Pick<ApiProfileStore, "getGlobalStateKey">): ApiConfigProfile[] {
	return stateManager.getGlobalStateKey("apiConfigProfiles") ?? []
}

export function readApiProfileAssignments(stateManager: Pick<ApiProfileStore, "getGlobalStateKey">): {
	askProfileId?: string
	actProfileId?: string
} {
	return {
		askProfileId: stateManager.getGlobalStateKey("askProfileId"),
		actProfileId: stateManager.getGlobalStateKey("actProfileId"),
	}
}

/**
 * Secret field names stored for a profile (values never leave secret storage).
 */
export function listProfileSecretKeys(stateManager: Pick<ApiProfileStore, "listSecretStorageKeys">, profileId: string): string[] {
	const prefix = `profile:${profileId}:`
	return stateManager
		.listSecretStorageKeys()
		.filter((key) => key.startsWith(prefix))
		.map((key) => key.slice(prefix.length))
}

export function readProfileSecrets(
	stateManager: Pick<ApiProfileStore, "listSecretStorageKeys" | "getSecretForKey">,
	profileId: string,
): Partial<Secrets> {
	const secrets: Record<string, string> = {}
	for (const key of listProfileSecretKeys(stateManager, profileId)) {
		if (!isSecretKey(key)) {
			continue
		}
		const value = stateManager.getSecretForKey(profileSecretStorageKey(profileId, key))
		if (value) {
			secrets[key] = value
		}
	}
	return secrets as Partial<Secrets>
}

export function writeProfileSecrets(
	stateManager: Pick<ApiProfileStore, "setSecretsForKeys">,
	profileId: string,
	secrets: Record<string, string | undefined>,
): void {
	const entries: Record<string, string | undefined> = {}
	for (const [key, value] of Object.entries(secrets)) {
		if (!isSecretKey(key)) {
			continue
		}
		entries[profileSecretStorageKey(profileId, key)] = value || undefined
	}
	stateManager.setSecretsForKeys(entries)
}

export function deleteProfileSecrets(
	stateManager: Pick<ApiProfileStore, "listSecretStorageKeys" | "setSecretsForKeys">,
	profileId: string,
): void {
	const prefix = `profile:${profileId}:`
	const entries: Record<string, undefined> = {}
	for (const key of stateManager.listSecretStorageKeys()) {
		if (key.startsWith(prefix)) {
			entries[key] = undefined
		}
	}
	stateManager.setSecretsForKeys(entries)
}

function sanitizeProfileOptions(options: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!options) {
		return undefined
	}
	const sanitized: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(options)) {
		// Secrets never live on the profile record itself — only under the
		// `profile:<id>:` secret scope — and only known settings keys persist.
		if (
			value === undefined ||
			key === "planModeReasoningEffort" ||
			key === "actModeReasoningEffort" ||
			isSecretKey(key) ||
			!ApiHandlerSettingsKeys.includes(key as (typeof ApiHandlerSettingsKeys)[number])
		) {
			continue
		}
		sanitized[key] = value
	}
	return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function normalizeApiType(value: string | undefined): OpenAiCompatibleApiType | undefined {
	return value === "chat" || value === "responses" ? value : undefined
}

export interface SaveApiProfileInput {
	id?: string
	name: string
	provider: string
	modelId: string
	openAiCompatibleApiType?: string
	reasoningEffort?: string
	options?: Record<string, unknown>
	secrets?: Record<string, string | undefined>
}

/**
 * Create or update a saved API configuration. When `id` matches an existing
 * profile the record is replaced and any provided secrets are merged into the
 * profile's secret scope; an absent `secrets` map leaves stored secrets intact.
 */
export function upsertApiConfigProfile(stateManager: ApiProfileStore, input: SaveApiProfileInput): ApiConfigProfile {
	const provider = toLegacyApiProvider(input.provider?.trim() || "") as ApiProvider | undefined
	if (!provider) {
		throw new Error("provider is required")
	}
	if (input.reasoningEffort && !isOpenaiReasoningEffort(input.reasoningEffort)) {
		throw new Error("Invalid reasoning effort")
	}
	const name = input.name?.trim() || PROFILE_PROVIDER_NAMES[provider] || provider
	const profiles = readApiConfigProfiles(stateManager)
	const existingIndex = input.id ? profiles.findIndex((p) => p.id === input.id) : -1
	const id = existingIndex >= 0 ? profiles[existingIndex].id : (input.id?.trim() ?? "") || randomUUID()

	if (existingIndex >= 0 && profiles[existingIndex].provider !== provider) {
		deleteProfileSecrets(stateManager, id)
	}
	if (input.secrets) {
		writeProfileSecrets(stateManager, id, input.secrets)
	}

	const profile: ApiConfigProfile = {
		id,
		name,
		provider,
		modelId: input.modelId ?? "",
		openAiCompatibleApiType: normalizeApiType(input.openAiCompatibleApiType),
		reasoningEffort: isOpenaiReasoningEffort(input.reasoningEffort) ? input.reasoningEffort : undefined,
		options: sanitizeProfileOptions(input.options),
	}

	const next = [...profiles]
	if (existingIndex >= 0) {
		next[existingIndex] = profile
	} else {
		next.push(profile)
	}
	stateManager.setGlobalStateBatch({ apiConfigProfiles: next })
	ensureApiConfigProfiles(stateManager)
	for (const mode of ["plan", "act"] as const) {
		if (stateManager.getGlobalStateKey(mode === "plan" ? "askProfileId" : "actProfileId") === id) {
			// Refresh saved model/connection edits without resetting the current effort.
			assignApiConfigProfile(stateManager, mode, id, false)
		}
	}
	return profile
}

/**
 * Delete a saved profile and its secrets, replacing affected assignments
 * before callers compare effective configurations. Keep at least one profile.
 */
export function deleteApiConfigProfile(stateManager: ApiProfileStore, profileId: string): boolean {
	const profiles = readApiConfigProfiles(stateManager)
	const next = profiles.filter((p) => p.id !== profileId)
	if (next.length === profiles.length) {
		return false
	}
	if (next.length === 0) {
		throw new Error("Cannot delete the last saved configuration. Create another configuration first.")
	}
	deleteProfileSecrets(stateManager, profileId)
	stateManager.setGlobalStateBatch({ apiConfigProfiles: next })
	ensureApiConfigProfiles(stateManager)
	return true
}

/**
 * Build the ApiConfiguration fragment an assigned profile writes into the
 * target mode's existing per-mode keys.
 */
export function buildApiConfigurationFromProfile(
	profile: ApiConfigProfile,
	secrets: Partial<Secrets>,
	mode: Mode,
	applyDefaultEffort = true,
): Partial<ApiConfiguration> {
	const provider = toLegacyApiProvider(profile.provider) as ApiProvider
	const updates: Record<string, unknown> = {}
	// A profile owns the entire connection and model configuration. Undefined
	// values deliberately remove legacy fields rather than inheriting them.
	for (const key of [...ApiHandlerSettingsKeys, ...SecretKeys]) {
		if (key.startsWith(mode === "plan" ? "actMode" : "planMode")) continue
		// Reads and saves preserve current effort; assignment resets it.
		if (key === `${mode}ModeReasoningEffort` && !applyDefaultEffort) continue
		updates[key] = undefined
	}
	Object.assign(updates, {
		[`${mode}ModeApiProvider`]: provider,
		[getProviderModelIdKey(provider, mode)]: profile.modelId,
	})

	for (const [key, value] of Object.entries(profile.options ?? {})) {
		if (value === undefined || isSecretKey(key) || key === "planModeReasoningEffort" || key === "actModeReasoningEffort") {
			continue
		}
		// Mode-prefixed option keys captured from one mode rewrite onto the
		// target mode's prefix; global keys apply as-is.
		let targetKey = key
		if (key.startsWith("planMode")) {
			targetKey = key.replace("planMode", `${mode}Mode`)
		} else if (key.startsWith("actMode")) {
			targetKey = key.replace("actMode", `${mode}Mode`)
		}
		if (isSettingsKey(targetKey)) {
			updates[targetKey] = value
		}
	}

	updates[`${mode}ModeApiProvider`] = provider
	updates[getProviderModelIdKey(provider, mode)] = profile.modelId
	updates.openAiCompatibleApiType = profile.openAiCompatibleApiType ?? "chat"
	if (applyDefaultEffort) {
		updates[`${mode}ModeReasoningEffort`] = profile.reasoningEffort ?? "none"
	}

	for (const [key, value] of Object.entries(secrets)) {
		if (value && isSecretKey(key)) {
			updates[key] = value
		}
	}

	return updates as Partial<ApiConfiguration>
}

// Keep both mode snapshots with each read so change notifications compare the
// values before and after a profile edit, including profile-scoped secrets.
const profileConfigurations = new WeakSet<ApiConfiguration>()

export function hasAssignedApiProfile(configuration: ApiConfiguration): boolean {
	return profileConfigurations.has(configuration)
}

const modeSnapshots = new WeakMap<ApiConfiguration, Record<Mode, ApiConfiguration>>()

export function resolveApiConfigurationForMode(configuration: ApiConfiguration, mode: Mode): ApiConfiguration {
	return modeSnapshots.get(configuration)?.[mode] ?? configuration
}

export function snapshotApiProfileConfiguration(store: ApiProfileStore, legacy: ApiConfiguration, mode: Mode): ApiConfiguration {
	const resolve = (target: Mode): ApiConfiguration => {
		const id = store.getGlobalStateKey(target === "plan" ? "askProfileId" : "actProfileId")
		if (!id) return { ...legacy }
		const profile = readApiConfigProfiles(store).find((entry) => entry.id === id)
		// A broken assignment must not fall through to another profile's secrets.
		const fragment = buildApiConfigurationFromProfile(
			profile ?? { id, name: "", provider: "openai", modelId: "" },
			profile ? readProfileSecrets(store, id) : {},
			target,
			false,
		)
		const resolved = { ...legacy, ...fragment }
		// Current model selection belongs to the mode, never to the saved record.
		if (profile) {
			const modelKey = getProviderModelIdKey(profile.provider, target) as keyof ApiConfiguration
			if (legacy[`${target}ModeApiProvider`] === profile.provider && legacy[modelKey] !== undefined) {
				Object.assign(resolved, { [modelKey]: legacy[modelKey] })
			}
		}
		profileConfigurations.add(resolved)
		return resolved
	}
	const snapshots = { plan: resolve("plan"), act: resolve("act") }
	const current = { ...snapshots[mode] }
	modeSnapshots.set(current, snapshots)
	if (profileConfigurations.has(snapshots[mode])) profileConfigurations.add(current)
	return current
}

/**
 * Assign a saved profile and write its provider/model options into mode keys.
 * Global connection keys remain a legacy fallback. Effective reads resolve
 * connection options and secrets from `askProfileId` / `actProfileId`.
 */
export function assignApiConfigProfile(
	stateManager: ApiProfileStore,
	mode: Mode,
	profileId: string,
	applyDefaultEffort = true,
): ApiConfigProfile {
	const profile = readApiConfigProfiles(stateManager).find((p) => p.id === profileId)
	if (!profile) {
		throw new Error(`No saved configuration with id "${profileId}"`)
	}
	const secrets = readProfileSecrets(stateManager, profile.id)
	const updates = buildApiConfigurationFromProfile(profile, secrets, mode, applyDefaultEffort)
	const modeUpdates = Object.fromEntries(Object.entries(updates).filter(([key]) => key.startsWith(`${mode}Mode`)))
	stateManager.setApiConfiguration(modeUpdates)
	stateManager.setGlobalStateBatch(modeUpdates)
	stateManager.setGlobalStateBatch({ [mode === "plan" ? "askProfileId" : "actProfileId"]: profile.id })
	return profile
}

// ---------------------------------------------------------------------------
// Migration: seed one profile per mode from the current configuration
// ---------------------------------------------------------------------------

function captureProfileFromConfiguration(
	_stateManager: ApiProfileStore,
	config: ApiConfiguration,
	mode: Mode,
): { profile: Omit<ApiConfigProfile, "id" | "name">; secrets: Record<string, string> } {
	const provider = toLegacyApiProvider(
		(mode === "plan" ? config.planModeApiProvider : config.actModeApiProvider) ?? "anthropic",
	) as ApiProvider
	const configRecord = config as Record<string, unknown>
	const modelId = (configRecord[getProviderModelIdKey(provider, mode)] as string | undefined)?.trim() ?? ""

	const options: Record<string, unknown> = {}
	for (const key of PROFILE_PROVIDER_OPTION_KEYS[provider] ?? []) {
		const value = configRecord[key]
		if (value !== undefined) {
			options[key] = value
		}
	}
	for (const suffix of PROFILE_PROVIDER_MODE_KEYS[provider] ?? []) {
		const key = `${mode}Mode${suffix}` as keyof ApiConfiguration
		const value = config[key]
		if (value !== undefined) {
			options[key] = value
		}
	}

	const effort = config[`${mode}ModeReasoningEffort`]
	const secrets: Record<string, string> = {}
	for (const key of PROFILE_PROVIDER_SECRET_KEYS[provider] ?? []) {
		const value = config[key] as string | undefined
		if (value) {
			secrets[key] = value
		}
	}

	return {
		profile: {
			provider,
			modelId,
			reasoningEffort: isOpenaiReasoningEffort(effort) ? effort : undefined,
			openAiCompatibleApiType: provider === "openai" ? normalizeApiType(config.openAiCompatibleApiType) : undefined,
			options: Object.keys(options).length > 0 ? options : undefined,
		},
		secrets,
	}
}

function profileSignature(profile: Omit<ApiConfigProfile, "id" | "name">, secrets: Record<string, string>): string {
	return JSON.stringify([
		profile.provider,
		profile.modelId,
		profile.reasoningEffort ?? "none",
		profile.openAiCompatibleApiType ?? "",
		profile.options ?? {},
		secrets,
	])
}

/**
 * Startup/save/delete migration only; serialization must use read helpers.
 * Ensure saved configurations exist. On first run (no stored profiles) one
 * profile is created per mode from the current plan/act configuration —
 * deduplicated when both modes share the same configuration — and assigned to
 * Ask / Act respectively. Dangling or missing assignments are repaired to the
 * first profile so every mode always resolves to a saved configuration.
 */
export function ensureApiConfigProfiles(stateManager: ApiProfileStore): {
	profiles: ApiConfigProfile[]
	askProfileId?: string
	actProfileId?: string
} {
	const profiles = readApiConfigProfiles(stateManager)
	let { askProfileId, actProfileId } = readApiProfileAssignments(stateManager)
	const updates: Record<string, unknown> = {}

	if (profiles.length === 0) {
		const config = stateManager.getApiConfiguration()
		const ask = captureProfileFromConfiguration(stateManager, config, "plan")
		const act = captureProfileFromConfiguration(stateManager, config, "act")

		const deduped = profileSignature(ask.profile, ask.secrets) === profileSignature(act.profile, act.secrets)
		const askProfile: ApiConfigProfile = {
			id: randomUUID(),
			name: PROFILE_PROVIDER_NAMES[ask.profile.provider] ?? ask.profile.provider,
			...ask.profile,
		}
		writeProfileSecrets(stateManager, askProfile.id, ask.secrets)

		let actProfile = askProfile
		if (!deduped) {
			actProfile = {
				id: randomUUID(),
				name: PROFILE_PROVIDER_NAMES[act.profile.provider] ?? act.profile.provider,
				...act.profile,
			}
			writeProfileSecrets(stateManager, actProfile.id, act.secrets)
		}

		const seeded = deduped ? [askProfile] : [askProfile, actProfile]
		updates.apiConfigProfiles = seeded
		askProfileId = askProfile.id
		actProfileId = actProfile.id
		updates.askProfileId = askProfileId
		updates.actProfileId = actProfileId
	} else {
		const known = new Set(profiles.map((p) => p.id))
		const fallback = profiles.find((p) => isAllowedApiProvider(p.provider))?.id ?? profiles[0]?.id
		if (!askProfileId || !known.has(askProfileId)) {
			askProfileId = fallback
			updates.askProfileId = askProfileId
		}
		if (!actProfileId || !known.has(actProfileId)) {
			actProfileId = fallback
			updates.actProfileId = actProfileId
		}
	}

	if (Object.keys(updates).length > 0) {
		stateManager.setGlobalStateBatch(updates)
		if (updates.askProfileId && askProfileId) assignApiConfigProfile(stateManager, "plan", askProfileId)
		if (updates.actProfileId && actProfileId) assignApiConfigProfile(stateManager, "act", actProfileId)
	}
	return { profiles: readApiConfigProfiles(stateManager), askProfileId, actProfileId }
}
