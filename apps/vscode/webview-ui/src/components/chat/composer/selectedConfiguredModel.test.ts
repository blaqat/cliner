import { createCompatibleConnection, createDefaultModelSettings, resolveModelValues } from "@shared/model-settings"
import { describe, expect, it } from "vitest"
import { selectedConfiguredModel, selectedModelOffersLevels } from "./selectedConfiguredModel"

const LEVELS = [
	{ id: "default", label: "Default", rank: 0, request: { kind: "default" } },
	{ id: "high", label: "High", rank: 1, request: { kind: "effort", value: "high" } },
] as never

const state = () => {
	const settings = createDefaultModelSettings()
	settings.connections.push(createCompatibleConnection("c"), {
		...createCompatibleConnection("p"),
		kind: "provider",
		providerId: "anthropic",
		options: {},
		secretRefs: {},
	} as never)
	settings.models.push(
		{ id: "plain", connectionId: "c", upstreamId: "plain", name: "", kind: "chat", overrides: {}, providerOptions: {} },
		{ id: "leveled", connectionId: "p", upstreamId: "leveled", name: "", kind: "chat", overrides: {}, providerOptions: {} },
	)
	settings.roles.chat = { modelId: "plain", levelId: "default" }
	const effective = {
		plain: resolveModelValues({}, undefined, {}),
		leveled: resolveModelValues({ levels: LEVELS }, undefined, {}),
	}
	return { modelSettings: { settings, effective } } as never as Parameters<typeof selectedConfiguredModel>[0]
}

describe("selectedConfiguredModel", () => {
	it("is undefined without the new store", () => {
		expect(selectedConfiguredModel({}, "act")).toBeUndefined()
	})
	it("uses the role, Ask's only when it's on, and this chat's pick first", () => {
		const s = state()
		expect(selectedConfiguredModel(s, "act")?.provider).toBe("openai")
		expect(selectedConfiguredModel(s, "plan")?.model.id).toBe("plain")
		const roles = s.modelSettings?.settings.roles
		if (roles) roles.ask = { enabled: true, pick: { modelId: "leveled", levelId: "default" } }
		expect(selectedConfiguredModel(s, "plan")?.provider).toBe("anthropic")
		s.composerApiSelection = {
			modelSelectionV1: { version: 1, act: { modelId: "leveled", levelId: "high" }, ask: null },
		} as never
		expect(selectedConfiguredModel(s, "act")?.pick).toEqual({ modelId: "leveled", levelId: "high" })
	})
	it("follows the default for a pick whose model is gone, and is undefined with no default", () => {
		const s = state()
		s.composerApiSelection = {
			modelSelectionV1: { version: 1, act: { modelId: "gone", levelId: "default" }, ask: null },
		} as never
		const fallback = s.modelSettings!.settings.roles.chat
		expect(selectedConfiguredModel(s, "act")?.pick).toEqual(fallback)
		s.modelSettings!.settings.roles.chat = null
		expect(selectedConfiguredModel(s, "act")).toBeUndefined()
	})
	it("the effort control follows the selected model's own levels", () => {
		const s = state()
		expect(selectedModelOffersLevels(s, "act")).toBe(false)
		s.composerApiSelection = {
			modelSelectionV1: { version: 1, act: { modelId: "leveled", levelId: "high" }, ask: null },
		} as never
		expect(selectedModelOffersLevels(s, "act")).toBe(true)
	})
})
