import type { ApiConfigProfile } from "@shared/api-profiles"
import { createCompatibleConnection, createDefaultModelSettings, resolveModelValues } from "@shared/model-settings"
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

describe("with the new store in use", () => {
	const published = (images: "yes" | "no" = "yes") => {
		const settings = createDefaultModelSettings()
		settings.connections.push({ ...createCompatibleConnection("c"), apiFormat: "responses" })
		settings.models.push(
			{ id: "m", connectionId: "c", upstreamId: "local", name: "", kind: "chat", overrides: {}, providerOptions: {} },
			{ id: "n", connectionId: "c", upstreamId: "other", name: "", kind: "chat", overrides: {}, providerOptions: {} },
		)
		settings.roles.chat = { modelId: "m", levelId: "default" }
		return {
			settings,
			effective: {
				m: resolveModelValues({ images, contextWindow: 64_000, inputPrice: 2, outputPrice: 4 }, undefined, {}),
				n: resolveModelValues({}, undefined, {}),
			},
		} as never
	}
	// The old selection names another provider; it says nothing about what runs.
	const stale = {
		apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-sonnet" },
	} as FocusedChatState
	const oldFallback = { provider: "anthropic" as const, modelId: "claude-sonnet" }

	it("reads the role's configured model, not the old configuration", () => {
		const model = resolveFocusedChatModel("act", { ...stale, modelSettings: published() }, oldFallback)
		expect(model).toMatchObject({ provider: "openai", modelId: "local", openAiCompatibleApiType: "responses" })
		expect(model.customModelInfo).toMatchObject({ contextWindow: 64_000, inputPrice: 2, outputPrice: 4 })
		expect(isTaskCostVisible(model.provider, model.customModelInfo, undefined, 1)).toBe(true)
	})
	it("reads this chat's pick over the role", () => {
		const model = resolveFocusedChatModel(
			"act",
			{
				...stale,
				modelSettings: published(),
				composerApiSelection: { modelSelectionV1: { version: 1, act: { modelId: "n", levelId: "default" }, ask: null } },
			} as FocusedChatState,
			oldFallback,
		)
		expect(model.modelId).toBe("other")
	})
	it("a live session wins, without another model's facts", () => {
		const model = resolveFocusedChatModel(
			"act",
			{
				...stale,
				modelSettings: published(),
				focusedSessionModels: { act: { provider: "anthropic", modelId: "running" } },
			} as FocusedChatState,
			oldFallback,
		)
		expect(model).toMatchObject({ provider: "anthropic", modelId: "running" })
		expect(model.customModelInfo).toBeUndefined()
	})
	it("a configured session keeps its model's facts for the context ring", () => {
		const model = resolveFocusedChatModel(
			"act",
			{
				...stale,
				modelSettings: published(),
				focusedSessionModels: {
					act: {
						provider: "openai",
						modelId: "local",
						reasoningEffort: "high",
						pick: { modelId: "m", levelId: "high" },
					},
				},
			} as FocusedChatState,
			oldFallback,
		)
		expect(model).toMatchObject({ provider: "openai", modelId: "local" })
		expect(model.customModelInfo).toMatchObject({ contextWindow: 64_000, inputPrice: 2, outputPrice: 4 })
	})
	it("with nothing picked, nothing is borrowed from the old selection", () => {
		const modelSettings = published() as { settings: { roles: { chat: unknown } } }
		modelSettings.settings.roles.chat = null
		expect(resolveFocusedChatModel("act", { ...stale, modelSettings } as never, oldFallback).modelId).toBe("")
	})
})

/** Settings default is the Anthropic profile; this chat overrides Act to the local OpenAI Compatible one. */
const overriddenChat: FocusedChatState = {
	apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-sonnet" },
	apiConfigProfiles: [settingsDefault, local],
	actProfileId: "default",
	composerApiSelection: { actProfileId: "local" },
}
const settingsFallback = { provider: "anthropic" as const, modelId: "claude-sonnet" }

describe("resolveFocusedChatModel", () => {
	it("uses the Settings default when the chat has no override", () => {
		const model = resolveFocusedChatModel("act", { ...overriddenChat, composerApiSelection: undefined }, settingsFallback)
		expect(model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet" })
		expect(model.customModelInfo).toBeUndefined()
		expect(effectiveContextWindow(model.customModelInfo, { contextWindow: 200_000 })).toBe(200_000)
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
