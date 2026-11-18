import { resolveAutomationModel } from "@shared/automation-models"
import { createDefaultModelSettings, type ModelRow, resolveModelValues } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { describe, expect, it } from "vitest"
import { parseDraftReply } from "./automation-draft"
import { serializeAutomation } from "./automation-file"
import { ticketToPr } from "./automation-fixtures"
import { parseDefinitionJson } from "./automation-json"

describe("parseDraftReply", () => {
	it("reads a fenced reply and its guesses", () => {
		const file = serializeAutomation(ticketToPr())
		const draft = parseDraftReply(`\`\`\`markdown\n${file}\n\`\`\`\nGUESS: Which module /test should use`)
		expect(draft.definition).toEqual(ticketToPr())
		expect(draft.guesses).toEqual(["Which module /test should use"])
	})

	it("keeps a draft with problems so the builder can show them", () => {
		const draft = parseDraftReply("Here you go:\n---\nname: Fix It\n---\n\n## Go\n- kind: thread\n\nDo {{nope}}")
		expect(draft.definition.name).toBe("Fix It")
		expect(draft.definition.steps).toHaveLength(1)
	})
})

describe("parseDefinitionJson", () => {
	it("keeps only known fields with the right types", () => {
		const parsed = parseDefinitionJson(
			JSON.stringify({
				name: " x ",
				description: 5,
				extra: true,
				arguments: [{ name: "a", kind: "weird", required: "yes" }],
				steps: [{ kind: "thread", id: "t", prompt: "p", mode: "act", worktree: "yes" }, { kind: "nope" }],
			}),
		)
		expect(parsed).toEqual({
			name: "x",
			title: "",
			description: "",
			arguments: [{ name: "a", kind: "text", required: false, description: "" }],
			steps: [{ kind: "thread", id: "t", title: "", prompt: "p", model: "", level: "", mode: "act", worktree: false }],
		})
		expect(() => parseDefinitionJson("{")).toThrow("couldn't be read")
	})
})

describe("resolveAutomationModel", () => {
	function state(): ModelSettingsState {
		const settings = createDefaultModelSettings()
		settings.connections = [
			{
				id: "c",
				name: "Anthropic",
				kind: "provider",
				providerId: "anthropic",
				baseUrl: null,
				auth: { kind: "none" },
				headers: [],
				requestTimeoutMs: null,
				defaults: {},
				options: {},
				secretRefs: {},
			},
		]
		const row = (id: string, name: string, upstreamId: string, reasoning: boolean): ModelRow => ({
			id,
			connectionId: "c",
			upstreamId,
			name,
			kind: "chat",
			overrides: reasoning
				? {
						reasoning: "yes",
						levels: [
							{ id: "low", label: "low", rank: 1, request: { kind: "effort", effort: "low" } as never },
							{ id: "medium", label: "medium", rank: 2, request: { kind: "effort", effort: "medium" } as never },
							{ id: "high", label: "high", rank: 3, request: { kind: "effort", effort: "high" } as never },
						],
						inputPrice: 15,
						outputPrice: 75,
					}
				: { reasoning: "no" },
			providerOptions: {},
		})
		settings.models = [row("m1", "Opus 5.5", "claude-opus-5-5", true), row("m2", "", "plain-model", false)]
		settings.roles.chat = { modelId: "m2", levelId: "default" }
		return {
			settings,
			configuredSecrets: {},
			effective: Object.fromEntries(
				settings.models.map((model) => [model.id, resolveModelValues(model.overrides, {}, {})]),
			),
			availability: {},
			planning: {},
			managed: [],
			migration: { status: "complete" } as never,
		}
	}

	it("finds a model by its name or upstream id, and a level by id or label", () => {
		expect(resolveAutomationModel(state(), "opus 5.5", "High", "ask")).toMatchObject({
			ok: true,
			pick: { modelId: "m1", levelId: "high" },
			label: "Opus 5.5",
			levelLabel: "High",
			inputPrice: 15,
		})
		expect(resolveAutomationModel(state(), "claude-opus-5-5", "", "act")).toMatchObject({
			ok: true,
			pick: { modelId: "m1", levelId: "medium" },
		})
	})

	it("uses the default model when the step names none", () => {
		expect(resolveAutomationModel(state(), "", "", "act")).toMatchObject({
			ok: true,
			isDefault: true,
			pick: { modelId: "m2", levelId: "default" },
			label: "plain-model",
		})
	})

	it("says what to fix for a missing model or level", () => {
		expect(resolveAutomationModel(state(), "GPT-9", "", "ask")).toEqual({
			ok: false,
			reason: "GPT-9 isn't set up. Add it in Settings › Models, or pick another model.",
		})
		expect(resolveAutomationModel(state(), "Opus 5.5", "ultra", "ask")).toMatchObject({ ok: false })
		const none = state()
		none.settings.roles.chat = null
		expect(resolveAutomationModel(none, "", "", "act")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("No default"),
		})
	})
})
