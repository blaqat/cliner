import { INHERIT_SUBAGENT_PROFILE, type SubagentProfileConnection, type SubagentSettings } from "@cline/core"
import type { ApiConfiguration } from "@shared/api"
import { type ApiProfileStore, buildApiConfigurationFromProfile, readProfileSecrets } from "@/core/controller/models/apiProfiles"
import { type ResolvedModelProfile, readModelProfiles, resolveModelProfile } from "@/core/controller/models/modelProfiles"
import { buildSdkProviderConfig } from "./sdk-api-handler"

/**
 * Resolve one profile into the SDK-side connection shape spawn_agent applies
 * when the agent picks it by id: the profile's configuration (secrets merged
 * the same way plan/act assignment resolves them) at the profile's effort.
 * apiKeyEnv is cleared so a profileless credential never falls back to
 * provider env vars.
 */
export function resolveSubagentProfileConnection(
	store: ApiProfileStore,
	resolved: ResolvedModelProfile,
): SubagentProfileConnection | undefined {
	const { configuration: saved, reasoningEffort } = resolved
	const fragment = buildApiConfigurationFromProfile(saved, readProfileSecrets(store, saved.id), "act", false)
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
		// "none" is the provider default, not an override.
		reasoningEffort: (reasoningEffort === "none"
			? undefined
			: reasoningEffort) as SubagentProfileConnection["reasoningEffort"],
	}
}

/**
 * Build the subagentSettings profile block for a session config when the
 * Subagents toggle on the Profiles page is on. Returns undefined when the
 * feature is off or no profiles resolve — the spawn tool then ignores
 * profile/reasoningEffort params and children inherit the parent model.
 */
export function buildSubagentProfileSettings(
	store: ApiProfileStore,
):
	| Pick<
			SubagentSettings,
			| "profiles"
			| "profileNames"
			| "allowedProfiles"
			| "defaultProfile"
			| "defaultReasoningEffort"
			| "profilesUseProviderDefaultEffort"
	  >
	| undefined {
	if (!store.getGlobalStateKey("subagentProfilesEnabled")) return undefined
	// Keyed by immutable profile id; names are display-only and may repeat.
	const byId = new Map<string, SubagentProfileConnection>()
	const names: Record<string, string> = {}
	for (const profile of readModelProfiles(store)) {
		const resolved = resolveModelProfile(store, profile.id)
		const connection = resolved && resolveSubagentProfileConnection(store, resolved)
		if (!connection) continue
		byId.set(profile.id, connection)
		names[profile.id] = profile.name.trim() || profile.id
	}
	if (byId.size === 0) return undefined

	const allowedProfiles: string[] = []
	for (const id of store.getGlobalStateKey("subagentAllowedModelProfileIds") ?? []) {
		if ((id === INHERIT_SUBAGENT_PROFILE || byId.has(id)) && !allowedProfiles.includes(id)) allowedProfiles.push(id)
	}

	const defaultProfileId = store.getGlobalStateKey("subagentDefaultModelProfileId")

	// Legacy setting: subagents that inherit the thread's model (the "parent"
	// choice, or no default profile) still run at this effort. Profiles carry
	// their own effort (the migration baked this in), so it never applies to one.
	const legacyEffort = store.getGlobalStateKey("subagentReasoningEffort")

	return {
		profiles: Object.fromEntries(byId),
		profilesUseProviderDefaultEffort: true,
		profileNames: names,
		allowedProfiles,
		defaultProfile: defaultProfileId && byId.has(defaultProfileId) ? defaultProfileId : undefined,
		defaultReasoningEffort: legacyEffort && legacyEffort !== "none" ? legacyEffort : undefined,
	}
}

/**
 * Opt-in adapter for the new settings store. The caller resolves each configured
 * row through the connection/secret resolver; this does not activate migration or
 * write SDK provider stores. Keep the legacy adapter above for old callers.
 */
export async function buildSubagentModelSettings(
	settings: import("@shared/model-settings").ModelSettings,
	resolveModel: (modelId: string) => Promise<{
		connection: import("@cline/core").SubagentModelConnection
		levels: import("@cline/core").SubagentModelLevel[]
	}>,
): Promise<SubagentSettings> {
	const policy = settings.subagents
	const ids = new Set(policy.allowed.flatMap((entry) => (entry.kind === "model" ? [entry.modelId] : [])))
	if (settings.roles.subagents.kind === "model") ids.add(settings.roles.subagents.pick.modelId)
	const models: Record<string, import("@cline/core").SubagentModelRecord> = {}
	// One broken model can't stop a chat. It's reported when the parent tries to use it.
	const unavailable: Record<string, { name: string; reason: string }> = {}
	for (const id of ids) {
		const row = settings.models.find((model) => model.id === id)
		if (!row) continue
		const name = row.name || row.upstreamId
		try {
			models[id] = { id, name, ...(await resolveModel(id)) }
		} catch (error) {
			unavailable[id] = { name, reason: error instanceof Error ? error.message : String(error) }
		}
	}
	const pick = settings.roles.subagents
	return {
		maxConcurrent: policy.maxConcurrent,
		allowWrite: policy.access.write,
		allowCommands: policy.access.commands,
		allowMcp: policy.access.mcp,
		allowWeb: policy.access.web,
		modelPolicy: {
			version: 1,
			models,
			unavailable,
			default:
				pick.kind === "model"
					? { model: pick.pick.modelId, level: pick.pick.levelId }
					: { model: "parent", level: pick.level },
			allowed: policy.allowed.map((entry) => ({
				model: entry.kind === "model" ? entry.modelId : "parent",
				levels: entry.levels,
			})),
			blocking: policy.blocking,
		},
	}
}
