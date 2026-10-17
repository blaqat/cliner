import { randomUUID } from "node:crypto"
import type { ApiConfiguration } from "@shared/api"
import type { ApiConfigProfile } from "@shared/api-profiles"
import type { ModelProfile } from "@shared/model-profiles"
import { isOpenaiReasoningEffort, type Mode, type OpenaiReasoningEffort } from "@shared/storage/types"
import { type ApiProfileStore, apiConfigurationForProfileId, assignApiConfigProfile, readApiConfigProfiles } from "./apiProfiles"

/**
 * Named profiles (Settings › Profiles): a saved configuration from the Models
 * page plus a reasoning effort. Every feature that picks "a model to run on"
 * stores a profile id and resolves it here into configuration + effort.
 *
 * Thread defaults are applied onto the existing per-mode selection
 * (`askProfileId`/`actProfileId` + `<mode>ModeReasoningEffort`), which new
 * chats capture at start and the composer pickers display. So a new thread
 * simply starts on its default profile's model and effort.
 */

/** Reserved id in subagentAllowedProfileIds: the agent may inherit the thread's model. */
export const INHERIT_PROFILE_ID = "parent"

export function readModelProfiles(store: Pick<ApiProfileStore, "getGlobalStateKey">): ModelProfile[] {
	return store.getGlobalStateKey("profiles") ?? []
}

export function findModelProfile(
	store: Pick<ApiProfileStore, "getGlobalStateKey">,
	id: string | undefined,
): ModelProfile | undefined {
	return id ? readModelProfiles(store).find((profile) => profile.id === id) : undefined
}

export interface ResolvedModelProfile {
	profile: ModelProfile
	configuration: ApiConfigProfile
	/** The profile's effort; "none" is the provider default. */
	reasoningEffort: OpenaiReasoningEffort
}

/** Profile → its configuration and effort. Undefined when either no longer exists. */
export function resolveModelProfile(
	store: Pick<ApiProfileStore, "getGlobalStateKey">,
	id: string | undefined,
): ResolvedModelProfile | undefined {
	const profile = findModelProfile(store, id)
	if (!profile) return undefined
	const configuration = readApiConfigProfiles(store).find((entry) => entry.id === profile.configurationId)
	if (!configuration) return undefined
	return { profile, configuration, reasoningEffort: profile.reasoningEffort ?? "none" }
}

/** A standalone feature's ApiConfiguration for a profile: its configuration run at its effort. */
export function apiConfigurationForModelProfile(store: ApiProfileStore, id: string, mode: Mode): ApiConfiguration {
	const resolved = resolveModelProfile(store, id)
	if (!resolved) throw new Error(`No profile with id "${id}"`)
	// Mutated in place so the result keeps its profile-owned identity.
	const configuration = apiConfigurationForProfileId(store, resolved.configuration.id, mode)
	configuration[`${mode}ModeReasoningEffort`] = resolved.reasoningEffort
	return configuration
}

const effortLabel = (effort: OpenaiReasoningEffort) =>
	effort === "none" ? "Provider default" : effort.charAt(0).toUpperCase() + effort.slice(1)

/** The profile a new thread uses in `mode`. */
export function threadDefaultProfileId(store: Pick<ApiProfileStore, "getGlobalStateKey">, mode: Mode): string | undefined {
	const fallback = store.getGlobalStateKey("threadDefaultProfileId")
	if (store.getGlobalStateKey("threadSeparateAskActProfiles") !== true) return fallback
	return store.getGlobalStateKey(mode === "plan" ? "threadAskProfileId" : "threadActProfileId") ?? fallback
}

/**
 * Write each mode's thread default profile onto the per-mode selection new
 * chats capture. Writes only what differs; returns whether anything changed.
 */
export function applyThreadDefaultProfiles(store: ApiProfileStore): boolean {
	let changed = false
	for (const mode of ["plan", "act"] as const) {
		const resolved = resolveModelProfile(store, threadDefaultProfileId(store, mode))
		if (!resolved) continue
		const assignmentKey = mode === "plan" ? "askProfileId" : "actProfileId"
		if (store.getGlobalStateKey(assignmentKey) !== resolved.configuration.id) {
			assignApiConfigProfile(store, mode, resolved.configuration.id, false)
			changed = true
		}
		const effortKey = `${mode}ModeReasoningEffort` as const
		if (store.getApiConfiguration()[effortKey] !== resolved.reasoningEffort) {
			store.setApiConfiguration({ [effortKey]: resolved.reasoningEffort })
			changed = true
		}
	}
	return changed
}

export interface ModelProfileInput {
	id?: string
	name?: string
	configurationId: string
	reasoningEffort?: string
}

/**
 * Replace the profile list (the Profiles page sends the whole list) and drop
 * references to removed profiles. Thread defaults fall back to the first
 * remaining profile so new threads keep a default.
 */
export function saveModelProfiles(store: ApiProfileStore, input: readonly ModelProfileInput[]): ModelProfile[] {
	const configurations = new Map(readApiConfigProfiles(store).map((entry) => [entry.id, entry]))
	const seen = new Set<string>()
	const profiles = input.map((entry): ModelProfile => {
		const configuration = configurations.get(entry.configurationId)
		if (!configuration) throw new Error("Choose a model for the profile")
		const effort = entry.reasoningEffort || "none"
		if (!isOpenaiReasoningEffort(effort)) throw new Error(`Invalid reasoning effort: ${entry.reasoningEffort}`)
		let id = entry.id?.trim() || randomUUID()
		if (seen.has(id) || id === INHERIT_PROFILE_ID) id = randomUUID()
		seen.add(id)
		return {
			id,
			name: entry.name?.trim() || configuration.name,
			configurationId: configuration.id,
			reasoningEffort: effort === "none" ? undefined : effort,
		}
	})
	const known = new Set(profiles.map((profile) => profile.id))
	const keep = (id: string | undefined) => (id && known.has(id) ? id : undefined)
	const firstId = profiles[0]?.id
	const defaultId = keep(store.getGlobalStateKey("threadDefaultProfileId")) ?? firstId
	store.setGlobalStateBatch({
		profiles,
		threadDefaultProfileId: defaultId,
		threadAskProfileId: keep(store.getGlobalStateKey("threadAskProfileId")) ?? defaultId,
		threadActProfileId: keep(store.getGlobalStateKey("threadActProfileId")) ?? defaultId,
		subagentDefaultProfileId: keep(store.getGlobalStateKey("subagentDefaultProfileId")),
		subagentAllowedProfileIds: (store.getGlobalStateKey("subagentAllowedProfileIds") ?? []).filter(
			(id) => id === INHERIT_PROFILE_ID || known.has(id),
		),
		walkthroughGenerateProfileId: keep(store.getGlobalStateKey("walkthroughGenerateProfileId")),
		threadTitlesProfileId: keep(store.getGlobalStateKey("threadTitlesProfileId")),
	})
	return profiles
}

/** Names of profiles that run on a configuration (blocks deleting it). */
export function profilesUsingConfiguration(store: Pick<ApiProfileStore, "getGlobalStateKey">, configurationId: string): string[] {
	return readModelProfiles(store)
		.filter((profile) => profile.configurationId === configurationId)
		.map((profile) => profile.name)
}

/**
 * Settings-side assignment of a configuration to a mode (onboarding): make
 * the thread default follow it, reusing a profile on that configuration or
 * creating one named after it.
 */
export function adoptConfigurationAsThreadDefault(store: ApiProfileStore, mode: Mode, configurationId: string): void {
	const configuration = readApiConfigProfiles(store).find((entry) => entry.id === configurationId)
	if (!configuration) return
	const profiles = [...readModelProfiles(store)]
	let profile = profiles.find((entry) => entry.configurationId === configurationId)
	if (!profile) {
		profile = {
			id: randomUUID(),
			name: configuration.name,
			configurationId,
			reasoningEffort: configuration.reasoningEffort === "none" ? undefined : configuration.reasoningEffort,
		}
		profiles.push(profile)
	}
	const separate = store.getGlobalStateKey("threadSeparateAskActProfiles") === true
	store.setGlobalStateBatch({
		profiles,
		...(separate
			? { [mode === "plan" ? "threadAskProfileId" : "threadActProfileId"]: profile.id }
			: { threadDefaultProfileId: profile.id }),
	})
}

/**
 * One-time migration from configuration-based settings. Earlier builds stored
 * configuration ids in askProfileId/actProfileId (Ask/Act defaults) and in
 * the subagent, walkthrough and thread-title settings. Creates one profile per
 * referenced configuration (named after it, at its default effort) and points
 * those settings at the profiles. Ask/Act keep the effort they currently
 * start with, so when that differs from the configuration's default the
 * thread default gets its own "Name · Effort" profile. Runs only while
 * `profiles` is unset, so it is idempotent.
 */
export function ensureModelProfiles(store: ApiProfileStore): ModelProfile[] {
	const stored = store.getGlobalStateKey("profiles")
	if (Array.isArray(stored)) {
		applyThreadDefaultProfiles(store)
		return stored
	}
	const configurations = new Map(readApiConfigProfiles(store).map((entry) => [entry.id, entry]))
	const profiles: ModelProfile[] = []
	const profileFor = (configurationId: string | undefined, effort?: OpenaiReasoningEffort): string | undefined => {
		const configuration = configurationId ? configurations.get(configurationId) : undefined
		if (!configuration) return undefined
		const configurationEffort = configuration.reasoningEffort ?? "none"
		const wanted = effort ?? configurationEffort
		const existing = profiles.find(
			(profile) => profile.configurationId === configuration.id && (profile.reasoningEffort ?? "none") === wanted,
		)
		if (existing) return existing.id
		const profile: ModelProfile = {
			id: randomUUID(),
			name: wanted === configurationEffort ? configuration.name : `${configuration.name} · ${effortLabel(wanted)}`,
			configurationId: configuration.id,
			reasoningEffort: wanted === "none" ? undefined : wanted,
		}
		profiles.push(profile)
		return profile.id
	}

	const current = store.getApiConfiguration()
	const modeEffort = (mode: Mode) => {
		const effort = current[`${mode}ModeReasoningEffort`]
		return isOpenaiReasoningEffort(effort) ? effort : undefined
	}
	const askId = profileFor(store.getGlobalStateKey("askProfileId"), modeEffort("plan"))
	const actId = profileFor(store.getGlobalStateKey("actProfileId"), modeEffort("act"))
	const subagentDefaultId = profileFor(store.getGlobalStateKey("subagentDefaultProfileId"))
	const allowedIds: string[] = []
	for (const id of store.getGlobalStateKey("subagentAllowedProfileIds") ?? []) {
		const mapped = id === INHERIT_PROFILE_ID ? id : profileFor(id)
		if (mapped && !allowedIds.includes(mapped)) allowedIds.push(mapped)
	}
	const walkthroughId = profileFor(store.getGlobalStateKey("walkthroughGenerateProfileId"))
	const titlesId = profileFor(store.getGlobalStateKey("threadTitlesProfileId"))

	const defaultId = actId ?? askId
	const separate = !!askId && !!actId && askId !== actId
	store.setGlobalStateBatch({
		profiles,
		threadDefaultProfileId: defaultId,
		threadSeparateAskActProfiles: separate,
		threadAskProfileId: separate ? askId : undefined,
		threadActProfileId: separate ? actId : undefined,
		subagentDefaultProfileId: subagentDefaultId,
		subagentAllowedProfileIds: allowedIds,
		walkthroughGenerateProfileId: walkthroughId,
		threadTitlesProfileId: titlesId,
	})
	applyThreadDefaultProfiles(store)
	return profiles
}
