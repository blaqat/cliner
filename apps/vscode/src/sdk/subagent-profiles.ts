import { INHERIT_SUBAGENT_PROFILE, type SubagentProfileConnection, type SubagentSettings } from "@cline/core"
import type { ApiConfiguration } from "@shared/api"
import type { ApiConfigProfile } from "@shared/api-profiles"
import {
	type ApiProfileStore,
	buildApiConfigurationFromProfile,
	readApiConfigProfiles,
	readProfileSecrets,
} from "@/core/controller/models/apiProfiles"
import { buildSdkProviderConfig } from "./sdk-api-handler"

/**
 * Resolve one saved API profile into the SDK-side connection shape spawn_agent
 * applies when the agent picks the profile by name. Secrets are merged into
 * the fragment the same way plan/act assignment resolves them; apiKeyEnv is
 * cleared so a profileless credential never falls back to provider env vars.
 */
export function resolveSubagentProfileConnection(
	store: ApiProfileStore,
	profile: ApiConfigProfile,
): SubagentProfileConnection | undefined {
	const secrets = readProfileSecrets(store, profile.id)
	const fragment = buildApiConfigurationFromProfile(profile, secrets, "act", false)
	const configuration = { ...store.getApiConfiguration(), ...fragment } as ApiConfiguration
	const providerConfig = buildSdkProviderConfig(configuration, "act")
	if (!providerConfig.providerId || !providerConfig.modelId) return undefined
	return {
		providerId: providerConfig.providerId,
		modelId: providerConfig.modelId,
		apiKey: providerConfig.apiKey,
		baseUrl: providerConfig.baseUrl,
		headers: providerConfig.headers,
		providerConfig: { ...providerConfig, apiKeyEnv: [] },
		reasoningEffort: (profile.reasoningEffort || undefined) as SubagentProfileConnection["reasoningEffort"],
	}
}

const profileName = (profile: ApiConfigProfile) => profile.name.trim() || profile.id

/**
 * Build the subagentSettings profile block for a session config when the
 * "Choose a profile for subagents" toggle is on. Returns undefined when the
 * feature is off or no profiles resolve — the spawn tool then ignores
 * profile/reasoningEffort params and children inherit the parent model.
 */
export function buildSubagentProfileSettings(
	store: ApiProfileStore,
): Pick<SubagentSettings, "profiles" | "allowedProfiles" | "defaultProfile" | "defaultReasoningEffort"> | undefined {
	if (!store.getGlobalStateKey("subagentProfilesEnabled")) return undefined
	const profiles = readApiConfigProfiles(store)
	const byName = new Map<string, SubagentProfileConnection>()
	for (const profile of profiles) {
		const name = profileName(profile)
		if (byName.has(name)) continue
		const connection = resolveSubagentProfileConnection(store, profile)
		if (connection) byName.set(name, connection)
	}
	if (byName.size === 0) return undefined

	const allowedProfiles: string[] = []
	for (const id of store.getGlobalStateKey("subagentAllowedProfileIds") ?? []) {
		if (id === INHERIT_SUBAGENT_PROFILE) {
			if (!allowedProfiles.includes(id)) allowedProfiles.push(id)
			continue
		}
		const profile = profiles.find((candidate) => candidate.id === id)
		const name = profile ? profileName(profile) : undefined
		if (name && byName.has(name) && !allowedProfiles.includes(name)) allowedProfiles.push(name)
	}

	const defaultProfileId = store.getGlobalStateKey("subagentDefaultProfileId")
	const defaultProfile = profiles.find((candidate) => candidate.id === defaultProfileId)
	const defaultName = defaultProfile ? profileName(defaultProfile) : undefined

	return {
		profiles: Object.fromEntries(byName),
		allowedProfiles,
		defaultProfile: defaultName && byName.has(defaultName) ? defaultName : undefined,
		defaultReasoningEffort: store.getGlobalStateKey("subagentReasoningEffort") || undefined,
	}
}
