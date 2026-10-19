import { describe, expect, it } from "bun:test"
import type { ApiConfiguration } from "@shared/api"
import type { ModelProfile } from "@shared/model-profiles"
import {
	type ApiProfileStore,
	captureTaskApiSelection,
	deleteApiConfigProfile,
	resolveApiConfigurationForTaskSelection,
	upsertApiConfigProfile,
} from "../apiProfiles"
import {
	adoptConfigurationAsThreadDefault,
	apiConfigurationForModelProfile,
	applyThreadDefaultProfiles,
	ensureModelProfiles,
	readModelProfiles,
	resolveModelProfile,
	saveModelProfiles,
	threadDefaultProfileId,
} from "../modelProfiles"

function createStore() {
	const globalState: Record<string, unknown> = {}
	const secretsStore: Record<string, string> = {}
	const apiConfig: Record<string, unknown> = {}
	const store: ApiProfileStore = {
		getGlobalStateKey: ((key: string) => globalState[key]) as ApiProfileStore["getGlobalStateKey"],
		setGlobalStateBatch: (updates) => {
			Object.assign(globalState, updates)
			Object.assign(apiConfig, updates)
		},
		getApiConfiguration: () => apiConfig as ApiConfiguration,
		setApiConfiguration: (updates) => {
			for (const [key, value] of Object.entries(updates)) {
				if (value !== undefined) apiConfig[key] = value
			}
		},
		getSecretForKey: (key) => secretsStore[key],
		setSecretsForKeys: (entries) => {
			for (const [key, value] of Object.entries(entries)) {
				if (value === undefined || value === "") delete secretsStore[key]
				else secretsStore[key] = value
			}
		},
		listSecretStorageKeys: () => Object.keys(secretsStore),
	}
	return { store, globalState, apiConfig }
}

/** Two configurations: Claude (default effort high) and Local (no default effort). */
function withConfigurations() {
	const ctx = createStore()
	const claude = upsertApiConfigProfile(ctx.store, {
		name: "Claude",
		provider: "anthropic",
		modelId: "claude-x",
		reasoningEffort: "high",
		secrets: { apiKey: "claude-key" },
	})
	const local = upsertApiConfigProfile(ctx.store, {
		name: "Local",
		provider: "openai",
		modelId: "qwen",
		options: { openAiBaseUrl: "http://local/v1" },
		secrets: { openAiApiKey: "local-key" },
	})
	return { ...ctx, claude, local }
}

const byId = (profiles: ModelProfile[], id: unknown) => profiles.find((profile) => profile.id === id)

describe("ensureModelProfiles (migration)", () => {
	it("creates one profile per referenced configuration and repoints every setting", () => {
		const { store, globalState, claude, local } = withConfigurations()
		globalState.askProfileId = claude.id
		globalState.actProfileId = claude.id
		globalState.planModeReasoningEffort = "high"
		globalState.actModeReasoningEffort = "high"
		Object.assign(store.getApiConfiguration(), { planModeReasoningEffort: "high", actModeReasoningEffort: "high" })
		globalState.subagentDefaultProfileId = local.id
		globalState.subagentAllowedProfileIds = ["parent", claude.id, local.id, "gone"]
		globalState.walkthroughGenerateProfileId = local.id
		globalState.threadTitlesProfileId = claude.id

		const profiles = ensureModelProfiles(store)

		expect(profiles.map((p) => [p.name, p.configurationId, p.reasoningEffort])).toEqual([
			["Claude", claude.id, "high"],
			["Local", local.id, undefined],
		])
		const claudeProfile = profiles[0]
		const localProfile = profiles[1]
		expect(globalState.threadDefaultProfileId).toBe(claudeProfile.id)
		expect(globalState.threadSeparateAskActProfiles).toBe(false)
		expect(globalState.subagentDefaultModelProfileId).toBe(localProfile.id)
		expect(globalState.subagentAllowedModelProfileIds).toEqual(["parent", claudeProfile.id, localProfile.id])
		expect(globalState.walkthroughGenerateModelProfileId).toBe(localProfile.id)
		expect(globalState.threadTitlesModelProfileId).toBe(claudeProfile.id)
		// The configuration references older releases read are left as they were.
		expect(globalState.subagentDefaultProfileId).toBe(local.id)
		expect(globalState.subagentAllowedProfileIds).toEqual(["parent", claude.id, local.id, "gone"])
		expect(globalState.walkthroughGenerateProfileId).toBe(local.id)
		expect(globalState.threadTitlesProfileId).toBe(claude.id)
		// Ask/Act keep starting on the same configuration and effort.
		expect(globalState.askProfileId).toBe(claude.id)
		expect(globalState.actProfileId).toBe(claude.id)
		expect(store.getApiConfiguration().actModeReasoningEffort).toBe("high")
	})

	it("keeps different Ask and Act defaults, and their current efforts, behind the switch", () => {
		const { store, globalState, claude, local } = withConfigurations()
		globalState.askProfileId = claude.id
		globalState.actProfileId = local.id
		Object.assign(store.getApiConfiguration(), { planModeReasoningEffort: "low", actModeReasoningEffort: "none" })

		const profiles = ensureModelProfiles(store)

		expect(globalState.threadSeparateAskActProfiles).toBe(true)
		const ask = byId(profiles, globalState.threadAskProfileId)
		const act = byId(profiles, globalState.threadActProfileId)
		// Claude's default effort is high, but Ask currently starts at low: never lose that.
		expect(ask).toMatchObject({ name: "Claude · Low", configurationId: claude.id, reasoningEffort: "low" })
		expect(act).toMatchObject({ name: "Local", configurationId: local.id })
		expect(globalState.threadDefaultProfileId).toBe(act?.id)
		expect(store.getApiConfiguration().planModeReasoningEffort).toBe("low")
		expect(globalState.askProfileId).toBe(claude.id)
		expect(globalState.actProfileId).toBe(local.id)
	})

	it("is idempotent", () => {
		const { store, globalState, claude } = withConfigurations()
		globalState.askProfileId = claude.id
		globalState.actProfileId = claude.id
		globalState.walkthroughGenerateProfileId = claude.id
		const first = ensureModelProfiles(store)
		const snapshot = structuredClone(globalState)
		const second = ensureModelProfiles(store)
		expect(second).toEqual(first)
		expect(globalState).toEqual(snapshot)
	})

	it("creates no profiles for settings that reference nothing", () => {
		const { store, globalState } = withConfigurations()
		globalState.askProfileId = undefined
		globalState.actProfileId = undefined
		expect(ensureModelProfiles(store)).toEqual([])
		expect(readModelProfiles(store)).toEqual([])
	})
})

/** What an older release does: write the legacy configuration-based keys directly, without touching profiles or the stamp. */
function olderReleaseSelects(
	ctx: ReturnType<typeof withConfigurations>,
	selection: { ask?: [string, string?]; act?: [string, string?] },
) {
	for (const [mode, chosen] of [
		["plan", selection.ask],
		["act", selection.act],
	] as const) {
		if (!chosen) continue
		ctx.globalState[mode === "plan" ? "askProfileId" : "actProfileId"] = chosen[0]
		ctx.apiConfig[`${mode}ModeReasoningEffort`] = chosen[1] ?? "none"
	}
}

function startedOnClaude() {
	const ctx = withConfigurations()
	ctx.globalState.askProfileId = ctx.claude.id
	ctx.globalState.actProfileId = ctx.claude.id
	Object.assign(ctx.apiConfig, { planModeReasoningEffort: "high", actModeReasoningEffort: "high" })
	ensureModelProfiles(ctx.store)
	return ctx
}

describe("upgrade after a downgrade (older release changed what new threads start on)", () => {
	it("adopts the configuration an older release picked instead of reapplying the stale default", () => {
		const ctx = startedOnClaude()
		const { store, globalState, apiConfig, local } = ctx
		expect(byId(readModelProfiles(store), globalState.threadDefaultProfileId)?.name).toBe("Claude")

		olderReleaseSelects(ctx, { ask: [local.id], act: [local.id] })
		ensureModelProfiles(store)

		const profile = byId(readModelProfiles(store), globalState.threadDefaultProfileId)
		expect(profile).toMatchObject({ name: "Local", configurationId: local.id })
		expect(globalState.threadSeparateAskActProfiles).toBe(false)
		// New threads start where the user left off in the older release.
		expect(globalState.askProfileId).toBe(local.id)
		expect(globalState.actProfileId).toBe(local.id)
		expect(apiConfig.actModeReasoningEffort).toBe("none")
		// And it sticks: another startup changes nothing.
		const snapshot = structuredClone(globalState)
		ensureModelProfiles(store)
		expect(globalState).toEqual(snapshot)
	})

	it("adopts a change to one mode only, behind the Ask/Act switch", () => {
		const ctx = startedOnClaude()
		const { store, globalState, claude, local } = ctx
		olderReleaseSelects(ctx, { act: [local.id] })
		ensureModelProfiles(store)

		expect(globalState.threadSeparateAskActProfiles).toBe(true)
		const profiles = readModelProfiles(store)
		expect(byId(profiles, globalState.threadAskProfileId)).toMatchObject({
			configurationId: claude.id,
			reasoningEffort: "high",
		})
		expect(byId(profiles, globalState.threadActProfileId)).toMatchObject({ configurationId: local.id })
		expect(globalState.askProfileId).toBe(claude.id)
		expect(globalState.actProfileId).toBe(local.id)
	})

	it("adopts an effort-only change and reuses a matching profile", () => {
		const ctx = startedOnClaude()
		const { store, globalState, claude } = ctx
		const before = readModelProfiles(store).length
		olderReleaseSelects(ctx, { ask: [claude.id, "low"], act: [claude.id, "low"] })
		ensureModelProfiles(store)
		const profile = byId(readModelProfiles(store), globalState.threadDefaultProfileId)
		expect(profile).toMatchObject({ configurationId: claude.id, reasoningEffort: "low", name: "Claude · Low" })
		expect(readModelProfiles(store)).toHaveLength(before + 1)

		// Choosing that exact selection again reuses the profile.
		olderReleaseSelects(ctx, { ask: [claude.id, "high"], act: [claude.id, "high"] })
		ensureModelProfiles(store)
		olderReleaseSelects(ctx, { ask: [claude.id, "low"], act: [claude.id, "low"] })
		ensureModelProfiles(store)
		expect(readModelProfiles(store)).toHaveLength(before + 1)
		expect(globalState.threadDefaultProfileId).toBe(profile?.id)
	})

	it("keeps the profiles the user edited since, and leaves an unchanged selection alone", () => {
		const ctx = startedOnClaude()
		const { store, globalState, claude, local } = ctx
		const [fast] = saveModelProfiles(store, [
			{ name: "Fast", configurationId: local.id },
			{ name: "Deep", configurationId: claude.id, reasoningEffort: "xhigh" },
		])
		globalState.threadDefaultProfileId = fast.id
		applyThreadDefaultProfiles(store)
		// This release stamps what it applied, so the selection is not a downgrade.
		ensureModelProfiles(store)
		const snapshot = structuredClone(globalState)
		ensureModelProfiles(store)
		expect(globalState).toEqual(snapshot)
		expect(globalState.threadDefaultProfileId).toBe(fast.id)
		expect(globalState.askProfileId).toBe(local.id)
	})

	it("adopts the legacy feature settings an older release changed, leaving the rest", () => {
		const ctx = startedOnClaude()
		const { store, globalState, claude, local } = ctx
		const [claudeProfile] = readModelProfiles(store)
		saveModelProfiles(store, [claudeProfile, { name: "Fast", configurationId: local.id }])
		const fast = readModelProfiles(store)[1]
		// The user set things up in this release.
		Object.assign(globalState, {
			subagentDefaultModelProfileId: claudeProfile.id,
			subagentAllowedModelProfileIds: ["parent", claudeProfile.id],
			threadTitlesModelProfileId: fast.id,
		})
		ensureModelProfiles(store)
		// Older releases never saw those: their keys are untouched.
		expect(globalState.subagentDefaultProfileId).toBeUndefined()
		expect(globalState.threadTitlesProfileId).toBeUndefined()

		// Downgrade: the older release sets only the walkthrough and subagent default.
		globalState.walkthroughGenerateProfileId = local.id
		globalState.subagentDefaultProfileId = claude.id
		ensureModelProfiles(store)

		const profiles = readModelProfiles(store)
		expect(byId(profiles, globalState.walkthroughGenerateModelProfileId)).toMatchObject({ configurationId: local.id })
		expect(byId(profiles, globalState.subagentDefaultModelProfileId)).toMatchObject({ configurationId: claude.id })
		// Untouched legacy groups don't clobber what the user set in this release.
		expect(globalState.threadTitlesModelProfileId).toBe(fast.id)
	})

	it("moves profile ids an earlier build wrote into the legacy keys over to the profile keys", () => {
		const { store, globalState, claude, local } = withConfigurations()
		const profiles = [
			{ id: "p-claude", name: "Claude", configurationId: claude.id },
			{ id: "p-local", name: "Local", configurationId: local.id },
		]
		Object.assign(globalState, {
			profiles,
			askProfileId: claude.id,
			actProfileId: claude.id,
			threadDefaultProfileId: "p-claude",
			subagentDefaultProfileId: "p-local",
			subagentAllowedProfileIds: ["parent", "p-claude"],
			walkthroughGenerateProfileId: "p-local",
			threadTitlesProfileId: "p-claude",
		})
		ensureModelProfiles(store)
		expect(globalState.subagentDefaultModelProfileId).toBe("p-local")
		expect(globalState.subagentAllowedModelProfileIds).toEqual(["parent", "p-claude"])
		expect(globalState.walkthroughGenerateModelProfileId).toBe("p-local")
		expect(globalState.threadTitlesModelProfileId).toBe("p-claude")
		expect(readModelProfiles(store)).toEqual(profiles)
		// Older releases get configuration ids back, which they can resolve.
		expect(globalState.subagentDefaultProfileId).toBe(local.id)
		expect(globalState.subagentAllowedProfileIds).toEqual(["parent", claude.id])
		expect(globalState.walkthroughGenerateProfileId).toBe(local.id)
		expect(globalState.threadTitlesProfileId).toBe(claude.id)
	})
})

describe("legacy subagent reasoning effort", () => {
	it("is baked into the migrated subagent profiles when the configuration has no effort of its own", () => {
		const { store, globalState, claude, local } = withConfigurations()
		Object.assign(globalState, {
			subagentReasoningEffort: "high",
			subagentDefaultProfileId: local.id,
			subagentAllowedProfileIds: ["parent", local.id, claude.id],
		})
		ensureModelProfiles(store)

		const profiles = readModelProfiles(store)
		const byConfiguration = (id: string) => profiles.filter((profile) => profile.configurationId === id)
		// Local has no effort of its own: it ran subagents at the legacy "high".
		expect(byConfiguration(local.id)).toEqual([expect.objectContaining({ name: "Local · High", reasoningEffort: "high" })])
		expect(byId(profiles, globalState.subagentDefaultModelProfileId)?.reasoningEffort).toBe("high")
		// Claude's own effort (high) took precedence over the setting, and still does.
		const legacyLow = withConfigurations()
		Object.assign(legacyLow.globalState, {
			subagentReasoningEffort: "low",
			subagentAllowedProfileIds: [legacyLow.claude.id],
		})
		ensureModelProfiles(legacyLow.store)
		expect(readModelProfiles(legacyLow.store)).toEqual([expect.objectContaining({ name: "Claude", reasoningEffort: "high" })])
		expect(globalState.subagentAllowedModelProfileIds).toEqual([
			"parent",
			byConfiguration(local.id)[0].id,
			byConfiguration(claude.id)[0].id,
		])
	})

	it("does not leak into thread defaults, walkthrough or titles", () => {
		const { store, globalState, apiConfig, claude, local } = withConfigurations()
		Object.assign(apiConfig, { planModeReasoningEffort: "none", actModeReasoningEffort: "none" })
		Object.assign(globalState, {
			subagentReasoningEffort: "high",
			askProfileId: local.id,
			actProfileId: local.id,
			walkthroughGenerateProfileId: local.id,
			threadTitlesProfileId: local.id,
		})
		ensureModelProfiles(store)
		const profiles = readModelProfiles(store)
		expect(profiles).toHaveLength(1)
		expect(profiles[0]).toMatchObject({ name: "Local", reasoningEffort: undefined })
		expect(claude.id).toBeTruthy()
	})

	it("re-applies a changed legacy effort from an older release to the subagent profiles", () => {
		const { store, globalState, local } = withConfigurations()
		Object.assign(globalState, { subagentDefaultProfileId: local.id, subagentReasoningEffort: "low" })
		ensureModelProfiles(store)
		expect(byId(readModelProfiles(store), globalState.subagentDefaultModelProfileId)?.reasoningEffort).toBe("low")
		globalState.subagentReasoningEffort = "xhigh"
		ensureModelProfiles(store)
		expect(byId(readModelProfiles(store), globalState.subagentDefaultModelProfileId)?.reasoningEffort).toBe("xhigh")
	})
})

describe("saveModelProfiles", () => {
	it("round-trips create, edit and delete, pruning references to removed profiles", () => {
		const { store, globalState, claude, local } = withConfigurations()
		const created = saveModelProfiles(store, [
			{ name: "Fast", configurationId: local.id },
			{ name: " Deep ", configurationId: claude.id, reasoningEffort: "xhigh" },
		])
		expect(created.map((p) => [p.name, p.configurationId, p.reasoningEffort])).toEqual([
			["Fast", local.id, undefined],
			["Deep", claude.id, "xhigh"],
		])
		const [fast, deep] = created
		expect(fast.id).toBeTruthy()
		expect(fast.id).not.toBe(deep.id)
		// First profile becomes the Thread default when there is none.
		expect(globalState.threadDefaultProfileId).toBe(fast.id)

		globalState.subagentAllowedModelProfileIds = ["parent", deep.id]
		globalState.walkthroughGenerateModelProfileId = deep.id
		const edited = saveModelProfiles(store, [fast, { ...deep, name: "Deeper", reasoningEffort: "medium" }])
		expect(byId(edited, deep.id)).toMatchObject({ name: "Deeper", reasoningEffort: "medium" })

		saveModelProfiles(store, [fast])
		expect(readModelProfiles(store)).toEqual([fast])
		expect(globalState.subagentAllowedModelProfileIds).toEqual(["parent"])
		expect(globalState.walkthroughGenerateModelProfileId).toBeUndefined()
	})

	it("rejects unknown configurations and invalid efforts, and names unnamed profiles after their model", () => {
		const { store, local } = withConfigurations()
		expect(() => saveModelProfiles(store, [{ name: "X", configurationId: "missing" }])).toThrow()
		expect(() => saveModelProfiles(store, [{ name: "X", configurationId: local.id, reasoningEffort: "max!" }])).toThrow()
		expect(saveModelProfiles(store, [{ name: "  ", configurationId: local.id }])[0].name).toBe("Local")
	})

	it("blocks deleting a configuration a profile runs on", () => {
		const { store, claude, local } = withConfigurations()
		saveModelProfiles(store, [{ name: "Deep", configurationId: claude.id }])
		expect(() => deleteApiConfigProfile(store, claude.id)).toThrow(/"Deep"/)
		expect(deleteApiConfigProfile(store, local.id)).toBe(true)
	})
})

describe("Thread defaults", () => {
	it("uses one profile for both modes until the switch is on", () => {
		const { store, globalState, claude, local } = withConfigurations()
		const [fast, deep] = saveModelProfiles(store, [
			{ name: "Fast", configurationId: local.id },
			{ name: "Deep", configurationId: claude.id, reasoningEffort: "xhigh" },
		])
		globalState.threadDefaultProfileId = fast.id
		globalState.threadAskProfileId = deep.id
		expect(threadDefaultProfileId(store, "plan")).toBe(fast.id)
		expect(threadDefaultProfileId(store, "act")).toBe(fast.id)

		globalState.threadSeparateAskActProfiles = true
		expect(threadDefaultProfileId(store, "plan")).toBe(deep.id)
		// An unset mode falls back to the shared default.
		expect(threadDefaultProfileId(store, "act")).toBe(fast.id)
	})

	it("starts a new thread on its default profile's configuration and effort", () => {
		const { store, globalState, claude, local } = withConfigurations()
		const [fast, deep] = saveModelProfiles(store, [
			{ name: "Fast", configurationId: local.id, reasoningEffort: "low" },
			{ name: "Deep", configurationId: claude.id, reasoningEffort: "xhigh" },
		])
		Object.assign(globalState, {
			threadSeparateAskActProfiles: true,
			threadAskProfileId: deep.id,
			threadActProfileId: fast.id,
		})
		expect(applyThreadDefaultProfiles(store)).toBe(true)
		expect(applyThreadDefaultProfiles(store)).toBe(false)

		// What a new chat captures at start (sdk-task-start-coordinator) …
		const selection = captureTaskApiSelection(store)
		expect(selection).toMatchObject({
			askProfileId: claude.id,
			actProfileId: local.id,
			planModeReasoningEffort: "xhigh",
			actModeReasoningEffort: "low",
		})
		// … resolves to the profile's model and effort, which the composer pickers show.
		const ask = resolveApiConfigurationForTaskSelection(store, store.getApiConfiguration(), "plan", selection)
		expect(ask.planModeApiProvider).toBe("anthropic")
		expect(ask.planModeApiModelId).toBe("claude-x")
		expect(ask.planModeReasoningEffort).toBe("xhigh")
		const act = resolveApiConfigurationForTaskSelection(store, store.getApiConfiguration(), "act", selection)
		expect(act.actModeApiProvider).toBe("openai")
		expect(act.actModeOpenAiModelId).toBe("qwen")
		expect(act.actModeReasoningEffort).toBe("low")
	})

	it("follows a Settings-side configuration assignment (onboarding)", () => {
		const { store, globalState, local } = withConfigurations()
		adoptConfigurationAsThreadDefault(store, "act", local.id)
		const profile = byId(readModelProfiles(store), globalState.threadDefaultProfileId)
		expect(profile).toMatchObject({ name: "Local", configurationId: local.id })
		adoptConfigurationAsThreadDefault(store, "plan", local.id)
		expect(readModelProfiles(store)).toHaveLength(1)
	})
})

describe("profile resolution", () => {
	it("resolves a profile to its configuration's connection at the profile's effort", () => {
		const { store, claude } = withConfigurations()
		const [deep] = saveModelProfiles(store, [{ name: "Deep", configurationId: claude.id, reasoningEffort: "low" }])
		expect(resolveModelProfile(store, deep.id)).toMatchObject({ configuration: { id: claude.id }, reasoningEffort: "low" })
		const configuration = apiConfigurationForModelProfile(store, deep.id, "act")
		expect(configuration.actModeApiProvider).toBe("anthropic")
		expect(configuration.apiKey).toBe("claude-key")
		// The profile's effort wins over the configuration's default (high).
		expect(configuration.actModeReasoningEffort).toBe("low")
		expect(resolveModelProfile(store, "missing")).toBeUndefined()
		expect(() => apiConfigurationForModelProfile(store, "missing", "act")).toThrow()
	})
})
