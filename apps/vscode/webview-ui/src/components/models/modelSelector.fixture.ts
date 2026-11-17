import {
	createCompatibleConnection,
	createDefaultModelSettings,
	type ModelLevel,
	type ModelRow,
	resolveModelValues,
} from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"

const level = (id: string, label: string, rank: number): ModelLevel => ({
	id,
	label,
	rank,
	request: id === "default" ? { kind: "default" } : { kind: "effort", value: id },
})

const ALL_LEVELS = [
	level("default", "Default", 0),
	level("low", "Low", 1),
	level("medium", "Medium", 2),
	level("high", "High", 3),
	level("xhigh", "XHigh", 4),
]

const model = (
	id: string,
	connectionId: string,
	name: string,
	overrides: ModelRow["overrides"],
	kind: ModelRow["kind"] = "chat",
): ModelRow => ({
	id,
	connectionId,
	upstreamId: name.toLowerCase().replaceAll(" ", "-"),
	name,
	kind,
	overrides,
	providerOptions: {},
})

/**
 * A store with two connections, for tests and stories: a full ladder, a model that lacks some levels,
 * no reasoning, unknown reasoning, one that can't run, one non-chat row and a shared name.
 */
export function modelSettingsFixture(): ModelSettingsState {
	const settings = createDefaultModelSettings()
	settings.revision = 7
	settings.connections = [
		{ ...createCompatibleConnection("gateway", "Company gateway"), baseUrl: "https://ai.acme.example/v1" },
		{ ...createCompatibleConnection("local", "Local vLLM"), baseUrl: "http://localhost:8000/v1" },
	]
	settings.models = [
		model("sol", "gateway", "GPT-6 Sol", { reasoning: "yes", levels: ALL_LEVELS }),
		model("g54", "gateway", "GPT-5.4", { reasoning: "yes", levels: [ALL_LEVELS[0], ALL_LEVELS[3], ALL_LEVELS[4]] }),
		model("tuned", "gateway", "acme-tuned-coder", {}),
		model("embed", "gateway", "text-embed-3", {}, "non-chat"),
		model("qwen", "local", "Qwen 3", { reasoning: "no" }),
		model("broken", "local", "Mistral 8", { reasoning: "no" }),
		model("sol-local", "local", "GPT-6 Sol", { reasoning: "yes", levels: ALL_LEVELS }),
	]
	settings.roles.chat = { modelId: "sol", levelId: "medium" }
	settings.roles.background.pick = { modelId: "qwen", levelId: "default" }
	const connections = new Map(settings.connections.map((connection) => [connection.id, connection]))
	return {
		settings,
		configuredSecrets: {},
		effective: Object.fromEntries(
			settings.models.map((row) => [
				row.id,
				resolveModelValues(row.overrides, undefined, connections.get(row.connectionId)?.defaults ?? {}),
			]),
		),
		availability: {
			...Object.fromEntries(settings.models.map((row) => [row.id, { available: true }])),
			broken: { available: false, reason: "Connection credentials are missing" },
		},
		planning: {},
		managed: [],
		migration: { status: "complete", retryable: false },
	}
}
