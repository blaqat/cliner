import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	readApiConfigProfiles: vi.fn(),
	readProfileSecrets: vi.fn((_store: unknown, id: string) => ({ apiKey: `${id}-key` })),
	buildApiConfigurationFromProfile: vi.fn((configuration: { id: string; modelId: string }, secrets: object) => ({
		actModeApiModelId: configuration.modelId,
		...secrets,
	})),
	buildSdkProviderConfig: vi.fn((configuration: { actModeApiModelId?: string; apiKey?: string }) => ({
		providerId: "anthropic",
		modelId: configuration.actModeApiModelId,
		apiKey: configuration.apiKey,
	})),
}))

vi.mock("@/core/controller/models/apiProfiles", () => ({
	readApiConfigProfiles: mocks.readApiConfigProfiles,
	readProfileSecrets: mocks.readProfileSecrets,
	buildApiConfigurationFromProfile: mocks.buildApiConfigurationFromProfile,
	apiConfigurationForProfileId: vi.fn(),
	assignApiConfigProfile: vi.fn(),
}))
vi.mock("@cline/core", () => ({ INHERIT_SUBAGENT_PROFILE: "parent" }))
vi.mock("./sdk-api-handler", () => ({ buildSdkProviderConfig: mocks.buildSdkProviderConfig }))

import { buildSubagentProfileSettings } from "./subagent-profiles"

function makeStore(settings: Record<string, unknown>) {
	return { getGlobalStateKey: (key: string) => settings[key], getApiConfiguration: () => ({}) } as never
}

const configurations = [
	{ id: "cfg-claude", name: "Claude", provider: "anthropic", modelId: "claude-x", reasoningEffort: "high" },
	{ id: "cfg-local", name: "Local", provider: "openai", modelId: "qwen" },
]
mocks.readApiConfigProfiles.mockReturnValue(configurations)

describe("buildSubagentProfileSettings", () => {
	it("returns nothing while the toggle is off", () => {
		const profiles = [{ id: "p1", name: "Fast", configurationId: "cfg-local" }]
		expect(buildSubagentProfileSettings(makeStore({ subagentProfilesEnabled: false, profiles }))).toBeUndefined()
	})

	it("resolves each profile to its configuration and the profile's own effort, keyed by profile id", () => {
		const profiles = [
			{ id: "fast", name: "Fast", configurationId: "cfg-local", reasoningEffort: "low" },
			// Same configuration, different effort: a distinct profile.
			{ id: "deep", name: "Deep", configurationId: "cfg-claude" },
			{ id: "orphan", name: "Orphan", configurationId: "cfg-missing" },
		]
		const settings = buildSubagentProfileSettings(
			makeStore({
				subagentProfilesEnabled: true,
				profiles,
				subagentAllowedModelProfileIds: ["deep", "parent", "orphan", "cfg-claude"],
				subagentDefaultModelProfileId: "fast",
				subagentReasoningEffort: "high",
			}),
		)
		expect(Object.keys(settings?.profiles ?? {})).toEqual(["fast", "deep"])
		expect(settings?.profiles?.fast).toMatchObject({ modelId: "qwen", apiKey: "cfg-local-key", reasoningEffort: "low" })
		// The profile's unset effort is the provider default, not the configuration's "high".
		expect(settings?.profiles?.deep).toMatchObject({ modelId: "claude-x", reasoningEffort: undefined })
		// Configuration ids and orphaned profiles are never authorized.
		expect(settings?.allowedProfiles).toEqual(["deep", "parent"])
		expect(settings?.defaultProfile).toBe("fast")
		expect(settings?.profileNames).toEqual({ fast: "Fast", deep: "Deep" })
		// Profiles carry their own effort; the legacy setting is only the fallback
		// for subagents that inherit the thread's model (see the SDK's spawn tool).
		expect(settings?.defaultReasoningEffort).toBe("high")
	})

	it("has no inherit fallback effort unless the legacy setting is set", () => {
		const profiles = [{ id: "a", name: "A", configurationId: "cfg-local" }]
		const settings = (extra: Record<string, unknown>) =>
			buildSubagentProfileSettings(makeStore({ subagentProfilesEnabled: true, profiles, ...extra }))
		expect(settings({})?.defaultReasoningEffort).toBeUndefined()
		expect(settings({ subagentReasoningEffort: "none" })?.defaultReasoningEffort).toBeUndefined()
		expect(settings({ subagentReasoningEffort: "medium" })?.defaultReasoningEffort).toBe("medium")
	})

	it("keeps both profiles that share a name, each with its own connection", () => {
		const settings = buildSubagentProfileSettings(
			makeStore({
				subagentProfilesEnabled: true,
				profiles: [
					{ id: "a", name: "Review", configurationId: "cfg-claude" },
					{ id: "b", name: "Review", configurationId: "cfg-local" },
				],
				subagentAllowedModelProfileIds: ["b"],
			}),
		)
		expect(Object.keys(settings?.profiles ?? {})).toEqual(["a", "b"])
		expect(settings?.profiles?.b.apiKey).toBe("cfg-local-key")
		expect(settings?.allowedProfiles).toEqual(["b"])
		expect(settings?.profileNames).toEqual({ a: "Review", b: "Review" })
	})
})
