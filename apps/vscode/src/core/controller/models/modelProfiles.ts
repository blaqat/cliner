import { randomUUID } from "node:crypto"
import type { ApiConfiguration } from "@shared/api"
import type { ApiConfigProfile } from "@shared/api-profiles"
import type { LegacyFeatureRefs, ModelProfile, ProfilesMigrationState, ThreadSelectionStamp } from "@shared/model-profiles"
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

/** Reserved id in subagentAllowedModelProfileIds: the agent may inherit the thread's model. */
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
		subagentDefaultModelProfileId: keep(store.getGlobalStateKey("subagentDefaultModelProfileId")),
		subagentAllowedModelProfileIds: (store.getGlobalStateKey("subagentAllowedModelProfileIds") ?? []).filter(
			(id) => id === INHERIT_PROFILE_ID || known.has(id),
		),
		walkthroughGenerateModelProfileId: keep(store.getGlobalStateKey("walkthroughGenerateModelProfileId")),
		threadTitlesModelProfileId: keep(store.getGlobalStateKey("threadTitlesModelProfileId")),
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

export const PROFILES_MIGRATION_VERSION = 1

const MODES = ["plan", "act"] as const

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
	(a ?? []).length === (b ?? []).length && (a ?? []).every((id, index) => id === (b ?? [])[index])

/** The Ask/Act configuration + effort new threads start from right now. */
export function readThreadSelection(
	store: Pick<ApiProfileStore, "getGlobalStateKey" | "getApiConfiguration">,
): ThreadSelectionStamp {
	const configuration = store.getApiConfiguration()
	return {
		askProfileId: store.getGlobalStateKey("askProfileId"),
		actProfileId: store.getGlobalStateKey("actProfileId"),
		planModeReasoningEffort: configuration.planModeReasoningEffort,
		actModeReasoningEffort: configuration.actModeReasoningEffort,
	}
}

function readLegacyFeatureRefs(store: Pick<ApiProfileStore, "getGlobalStateKey">): LegacyFeatureRefs {
	return {
		subagentDefaultProfileId: store.getGlobalStateKey("subagentDefaultProfileId"),
		subagentAllowedProfileIds: [...(store.getGlobalStateKey("subagentAllowedProfileIds") ?? [])],
		walkthroughGenerateProfileId: store.getGlobalStateKey("walkthroughGenerateProfileId"),
		threadTitlesProfileId: store.getGlobalStateKey("threadTitlesProfileId"),
		subagentReasoningEffort: store.getGlobalStateKey("subagentReasoningEffort"),
	}
}

/**
 * Find-or-create the profile for a configuration at an effort (default: the
 * configuration's own). New profiles are named after the configuration, plus
 * the effort when it isn't the configuration's default. Pushes onto `profiles`.
 */
function createProfileFactory(profiles: ModelProfile[], configurations: Map<string, ApiConfigProfile>) {
	return (configurationId: string | undefined, effort?: OpenaiReasoningEffort): string | undefined => {
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
}

type ProfileFactory = ReturnType<typeof createProfileFactory>

const validEffort = (effort: unknown): OpenaiReasoningEffort | undefined => (isOpenaiReasoningEffort(effort) ? effort : undefined)

/**
 * Older releases changed the Ask/Act selection after this release stamped it:
 * adopt what they chose as the thread defaults. A mode counts as changed when
 * its configuration or effort differs from the stamp. Other differences from
 * the stamp don't exist: this release stamps every selection it persists
 * (focusing a chat included), so those are never mistaken for a downgrade.
 */
function adoptOlderReleaseSelection(store: ApiProfileStore, factory: ProfileFactory): void {
	const stamp = store.getGlobalStateKey("threadSelectionStamp")
	if (!stamp) return
	const live = readThreadSelection(store)
	const adopted: Partial<Record<Mode, string>> = {}
	for (const mode of MODES) {
		const idKey = mode === "plan" ? "askProfileId" : "actProfileId"
		const effortKey = `${mode}ModeReasoningEffort` as const
		if (live[idKey] === stamp[idKey] && live[effortKey] === stamp[effortKey]) continue
		const id = factory(live[idKey], validEffort(live[effortKey]))
		if (id) adopted[mode] = id
	}
	if (!adopted.plan && !adopted.act) return

	const ask = adopted.plan ?? threadDefaultProfileId(store, "plan")
	const act = adopted.act ?? threadDefaultProfileId(store, "act")
	if (!ask || !act) return
	if (ask === act && store.getGlobalStateKey("threadSeparateAskActProfiles") !== true) {
		store.setGlobalStateBatch({ threadDefaultProfileId: ask })
	} else {
		store.setGlobalStateBatch({
			threadSeparateAskActProfiles: true,
			threadAskProfileId: ask,
			threadActProfileId: act,
			threadDefaultProfileId: store.getGlobalStateKey("threadDefaultProfileId") ?? act,
		})
	}
}

/**
 * Point the profile-based feature settings at profiles built from the legacy
 * configuration references, for each group of legacy settings that differs
 * from what was last reconciled (everything, the first time). Legacy keys are
 * the older releases' territory and are never written, except to put back a
 * configuration id where an earlier build of this release overwrote one with a
 * profile id the older releases can't resolve.
 */
function adoptLegacyFeatureRefs(
	store: ApiProfileStore,
	factory: ProfileFactory,
	profiles: ModelProfile[],
	marker: ProfilesMigrationState | undefined,
): LegacyFeatureRefs {
	const legacy = readLegacyFeatureRefs(store)
	const last = marker?.legacy
	const configurations = new Map(readApiConfigProfiles(store).map((entry) => [entry.id, entry]))
	const profileIds = new Set(profiles.map((profile) => profile.id))
	const restore = (id: string | undefined) =>
		id && profileIds.has(id) ? (profiles.find((profile) => profile.id === id)?.configurationId ?? id) : id

	// A reference is a profile already (earlier build of this release) or a configuration.
	const toProfile = (id: string | undefined, effort?: OpenaiReasoningEffort): string | undefined =>
		id && profileIds.has(id) ? id : factory(id, effort)

	const legacyEffort = legacy.subagentReasoningEffort
	// Subagents used the call's effort, else the configuration's, else this
	// setting. Bake the last two into the profile so the first run on a
	// profile keeps the effort the same subagent ran at before.
	const subagentProfile = (id: string | undefined): string | undefined => {
		const configuration = id ? configurations.get(id) : undefined
		const effort = configuration ? (configuration.reasoningEffort ?? validEffort(legacyEffort)) : undefined
		return toProfile(id, effort)
	}

	const updates: Record<string, unknown> = {}
	if (
		!last ||
		legacy.subagentDefaultProfileId !== last.subagentDefaultProfileId ||
		!sameList(legacy.subagentAllowedProfileIds, last.subagentAllowedProfileIds) ||
		legacy.subagentReasoningEffort !== last.subagentReasoningEffort
	) {
		const allowed: string[] = []
		for (const id of legacy.subagentAllowedProfileIds ?? []) {
			const mapped = id === INHERIT_PROFILE_ID ? id : subagentProfile(id)
			if (mapped && !allowed.includes(mapped)) allowed.push(mapped)
		}
		updates.subagentDefaultModelProfileId = subagentProfile(legacy.subagentDefaultProfileId)
		updates.subagentAllowedModelProfileIds = allowed
	}
	if (!last || legacy.walkthroughGenerateProfileId !== last.walkthroughGenerateProfileId) {
		updates.walkthroughGenerateModelProfileId = toProfile(legacy.walkthroughGenerateProfileId)
	}
	if (!last || legacy.threadTitlesProfileId !== last.threadTitlesProfileId) {
		updates.threadTitlesModelProfileId = toProfile(legacy.threadTitlesProfileId)
	}
	if (Object.keys(updates).length > 0) store.setGlobalStateBatch(updates)

	const reconciled: LegacyFeatureRefs = {
		subagentDefaultProfileId: restore(legacy.subagentDefaultProfileId),
		subagentAllowedProfileIds: (legacy.subagentAllowedProfileIds ?? []).map((id) => restore(id) ?? id),
		walkthroughGenerateProfileId: restore(legacy.walkthroughGenerateProfileId),
		threadTitlesProfileId: restore(legacy.threadTitlesProfileId),
		subagentReasoningEffort: legacy.subagentReasoningEffort,
	}
	const restored: Record<string, unknown> = {}
	for (const key of ["subagentDefaultProfileId", "walkthroughGenerateProfileId", "threadTitlesProfileId"] as const) {
		if (reconciled[key] !== legacy[key]) restored[key] = reconciled[key]
	}
	if (!sameList(reconciled.subagentAllowedProfileIds, legacy.subagentAllowedProfileIds)) {
		restored.subagentAllowedProfileIds = reconciled.subagentAllowedProfileIds
	}
	if (Object.keys(restored).length > 0) store.setGlobalStateBatch(restored)
	return reconciled
}

/**
 * Reconcile profiles with the configuration-based settings older releases
 * use. Safe to run any number of times, at every startup:
 *
 * - First run (`profiles` unset): create one profile per referenced
 *   configuration (named after it, at its default effort) and point the new
 *   profile-based settings at them. Ask/Act keep the effort they currently
 *   start with, so when that differs from the configuration's default the
 *   thread default gets its own "Name · Effort" profile.
 * - Later runs: if an older release (a downgrade) changed the Ask/Act
 *   selection or the legacy feature settings since this release last
 *   recorded them, adopt those changes into profiles; otherwise leave the
 *   user's profiles alone.
 * - Always: apply the thread defaults onto the Ask/Act selection and record
 *   what was reconciled.
 *
 * The caller must hold the cross-window lock with persisted state reloaded
 * (see StateManager), so this never works from a stale view.
 */
export function ensureModelProfiles(store: ApiProfileStore): ModelProfile[] {
	const stored = store.getGlobalStateKey("profiles")
	const firstRun = !Array.isArray(stored)
	const profiles: ModelProfile[] = firstRun ? [] : structuredClone(stored)
	const configurations = new Map(readApiConfigProfiles(store).map((entry) => [entry.id, entry]))
	const factory = createProfileFactory(profiles, configurations)
	const marker = store.getGlobalStateKey("profilesMigration")

	if (firstRun) {
		const selection = readThreadSelection(store)
		const askId = factory(selection.askProfileId, validEffort(selection.planModeReasoningEffort))
		const actId = factory(selection.actProfileId, validEffort(selection.actModeReasoningEffort))
		const separate = !!askId && !!actId && askId !== actId
		store.setGlobalStateBatch({
			threadDefaultProfileId: actId ?? askId,
			threadSeparateAskActProfiles: separate,
			threadAskProfileId: separate ? askId : undefined,
			threadActProfileId: separate ? actId : undefined,
		})
	} else {
		adoptOlderReleaseSelection(store, factory)
	}
	const legacy = adoptLegacyFeatureRefs(store, factory, profiles, marker)

	// Profiles, the settings that refer to them (set above) and the marker are
	// pending together and persist in one write. Unchanged values aren't
	// rewritten, so a steady-state startup saves nothing.
	const changes: Record<string, unknown> = {}
	const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
	if (firstRun || differs(profiles, stored)) changes.profiles = profiles
	const next: ProfilesMigrationState = { version: PROFILES_MIGRATION_VERSION, legacy }
	if (differs(next, marker)) changes.profilesMigration = next
	if (Object.keys(changes).length > 0) store.setGlobalStateBatch(changes)
	applyThreadDefaultProfiles(store)
	const stamp = readThreadSelection(store)
	if (differs(stamp, store.getGlobalStateKey("threadSelectionStamp")))
		store.setGlobalStateBatch({ threadSelectionStamp: stamp })
	return profiles
}

/** Keys whose persisted values make up the thread selection stamp. */
export const THREAD_SELECTION_KEYS = [
	"askProfileId",
	"actProfileId",
	"planModeReasoningEffort",
	"actModeReasoningEffort",
] as const

/** The stamp for a set of selection values (the persistence hook in StateManager uses this). */
export function threadSelectionStamp(
	values: Partial<Record<(typeof THREAD_SELECTION_KEYS)[number], unknown>>,
): ThreadSelectionStamp {
	return Object.fromEntries(THREAD_SELECTION_KEYS.map((key) => [key, values[key]])) as ThreadSelectionStamp
}
