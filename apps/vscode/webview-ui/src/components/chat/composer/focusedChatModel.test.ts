import type { ApiConfigProfile } from "@shared/api-profiles"
import { describe, expect, it } from "vitest"
import { isTaskCostVisible } from "@/hooks/useTaskCostVisible"
import { effectiveContextWindow, type FocusedChatState, resolveFocusedChatModel } from "./focusedChatModel"

const settingsDefault: ApiConfigProfile = { id: "default", name: "Claude", provider: "anthropic", modelId: "claude-sonnet" }
const local: ApiConfigProfile = {
	id: "local",
	name: "Local",
	provider: "openai",
	modelId: "qwen-coder",
	openAiCompatibleApiType: "responses",
	options: {
		planModeOpenAiModelInfo: { contextWindow: 32_000, inputPrice: 0.5, outputPrice: 1.5, supportsPromptCache: false },
	},
}

/** Settings default is the Anthropic profile; this chat overrides Act to the local OpenAI Compatible one. */
const overriddenChat: FocusedChatState = {
	apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-sonnet" },
	apiConfigProfiles: [settingsDefault, local],
	actProfileId: "default",
	composerApiSelection: { actProfileId: "local" },
}
const settingsFallback = { provider: "anthropic" as const, modelId: "claude-sonnet" }

describe("resolveFocusedChatModel", () => {
	it("describes the chat's override, not the Settings default", () => {
		const model = resolveFocusedChatModel("act", overriddenChat, settingsFallback)
		expect(model).toMatchObject({ provider: "openai", modelId: "qwen-coder", openAiCompatibleApiType: "responses" })
		expect(model.profile?.id).toBe("local")
		expect(effectiveContextWindow(model.customModelInfo, { contextWindow: 200_000 })).toBe(32_000)
		// The override's prices make its cost meaningful even though Settings' default is another provider.
		expect(isTaskCostVisible(model.provider, model.customModelInfo, "unknown", 0.42)).toBe(true)
	})

	it("uses the Settings default when the chat has no override", () => {
		const model = resolveFocusedChatModel("act", { ...overriddenChat, composerApiSelection: undefined }, settingsFallback)
		expect(model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet" })
		expect(model.customModelInfo).toBeUndefined()
		expect(effectiveContextWindow(model.customModelInfo, { contextWindow: 200_000 })).toBe(200_000)
	})

	it("prefers the live session's model while a picked change is pending", () => {
		const model = resolveFocusedChatModel(
			"act",
			{
				...overriddenChat,
				composerApiSelection: { actProfileId: "default" },
				focusedSessionModels: { act: { profileId: "local", provider: "openai", modelId: "qwen-coder" } },
			},
			settingsFallback,
		)
		expect(model.profile?.id).toBe("local")
		expect(model.customModelInfo?.contextWindow).toBe(32_000)
	})

	it("drops a profile edited since the session was built", () => {
		const model = resolveFocusedChatModel(
			"act",
			{
				...overriddenChat,
				focusedSessionModels: { act: { profileId: "local", provider: "openai", modelId: "older-model" } },
			},
			settingsFallback,
		)
		expect(model).toMatchObject({ provider: "openai", modelId: "older-model" })
		expect(model.profile).toBeUndefined()
		expect(model.customModelInfo).toBeUndefined()
	})

	it("resolves Ask from the chat's Ask selection", () => {
		const model = resolveFocusedChatModel(
			"plan",
			{ ...overriddenChat, composerApiSelection: { askProfileId: "local", actProfileId: "default" } },
			settingsFallback,
		)
		expect(model.profile?.id).toBe("local")
	})

	it("uses the composer configuration's model info for chats without a saved configuration", () => {
		const model = resolveFocusedChatModel(
			"act",
			{
				apiConfiguration: {
					actModeApiProvider: "openai",
					actModeOpenAiModelId: "custom",
					actModeOpenAiModelInfo: { contextWindow: 64_000, supportsPromptCache: false },
				},
			},
			{ provider: "openai", modelId: "custom" },
		)
		expect(model.customModelInfo?.contextWindow).toBe(64_000)
	})
})

describe("effectiveContextWindow", () => {
	it("lets a user-set window override the catalog", () => {
		expect(effectiveContextWindow({ contextWindow: 32_000 }, { contextWindow: 200_000 })).toBe(32_000)
	})

	it("treats the safe default as unset, like the host does", () => {
		expect(effectiveContextWindow({ contextWindow: 128_000 }, { contextWindow: 200_000 })).toBe(200_000)
		expect(effectiveContextWindow({ contextWindow: 128_000 }, {})).toBe(128_000)
	})

	it("is unknown when neither side knows", () => {
		expect(effectiveContextWindow(undefined, {})).toBeUndefined()
	})
})
