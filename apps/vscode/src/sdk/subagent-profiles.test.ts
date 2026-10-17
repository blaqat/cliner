import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	readApiConfigProfiles: vi.fn(),
	readProfileSecrets: vi.fn(() => ({})),
	buildApiConfigurationFromProfile: vi.fn(() => ({})),
	buildSdkProviderConfig: vi.fn(),
}))

vi.mock("@/core/controller/models/apiProfiles", () => ({
	readApiConfigProfiles: mocks.readApiConfigProfiles,
	readProfileSecrets: mocks.readProfileSecrets,
	buildApiConfigurationFromProfile: mocks.buildApiConfigurationFromProfile,
}))
vi.mock("@cline/core", () => ({ INHERIT_SUBAGENT_PROFILE: "parent" }))
vi.mock("./sdk-api-handler", () => ({ buildSdkProviderConfig: mocks.buildSdkProviderConfig }))

import { buildSubagentProfileSettings } from "./subagent-profiles"

function makeStore(settings: Record<string, unknown>) {
	return { getGlobalStateKey: (key: string) => settings[key], getApiConfiguration: () => ({}) } as never
}

const profiles = [
	{ id: "a", name: "Fast", reasoningEffort: "low" },
	{ id: "b", name: "Deep" },
]

describe("buildSubagentProfileSettings", () => {
	it("returns nothing while the toggle is off", () => {
		mocks.readApiConfigProfiles.mockReturnValue(profiles)
		expect(buildSubagentProfileSettings(makeStore({ subagentProfilesEnabled: false }))).toBeUndefined()
	})

	it("maps profile ids to names for the allowlist and default, keeping the parent option", () => {
		mocks.readApiConfigProfiles.mockReturnValue(profiles)
		mocks.buildSdkProviderConfig.mockImplementation(() => ({ providerId: "anthropic", modelId: "m" }))
		const settings = buildSubagentProfileSettings(
			makeStore({
				subagentProfilesEnabled: true,
				subagentAllowedProfileIds: ["b", "parent", "missing"],
				subagentDefaultProfileId: "a",
				subagentReasoningEffort: "high",
			}),
		)
		expect(settings?.allowedProfiles).toEqual(["Deep", "parent"])
		expect(settings?.defaultProfile).toBe("Fast")
		expect(settings?.defaultReasoningEffort).toBe("high")
		expect(Object.keys(settings?.profiles ?? {})).toEqual(["Fast", "Deep"])
		expect(settings?.profiles?.Fast.reasoningEffort).toBe("low")
	})
})
