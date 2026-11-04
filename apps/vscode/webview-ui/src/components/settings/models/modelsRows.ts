import type { ModelPick, RoleSettings, SubagentPick } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { ModelSettingsRequestV1 } from "@shared/proto/cline/models"
import { ModelsServiceClient } from "@/services/grpc-client"
import { action, preference, state } from "../shell/rowFactories"
import type { SettingsRow, SettingsRowContext } from "../shell/settingsRegistry"

const PROVIDER_MANAGED_KEYS = [
	"remoteConfiguredProviders",
	"openAiBaseUrl",
	"openAiHeaders",
	"azureApiVersion",
	"azureIdentity",
	"awsRegion",
	"awsUseCrossRegionInference",
	"awsUseGlobalInference",
	"awsBedrockUsePromptCache",
	"awsBedrockEndpoint",
	"liteLlmBaseUrl",
	"vertexProjectId",
	"vertexRegion",
	"anthropicBaseUrl",
]

const rolesOf = (ctx: SettingsRowContext) => ctx.state.modelSettings?.settings.roles

/** Revision-checked against the latest store, not the last published copy. */
const updateRoles = async (change: (roles: RoleSettings) => RoleSettings, extra?: { requestTimeoutMs: number | null }) => {
	const response = await ModelsServiceClient.getModelSettings(ModelSettingsRequestV1.create({ json: "{}" }))
	const latest = JSON.parse(response.json) as ModelSettingsState
	await ModelsServiceClient.setModelRoles(
		ModelSettingsRequestV1.create({
			json: JSON.stringify({ expectedRevision: latest.settings.revision, roles: change(latest.settings.roles), ...extra }),
		}),
	)
}

const useOverride = (
	key: "titles" | "commitMessages" | "generate",
	id: string,
	label: string,
	aliases: string[],
	description?: string,
) =>
	preference<ModelPick | null>({
		id,
		parent: "models.advanced",
		label,
		description,
		aliases,
		defaultValue: () => null,
		read: (ctx) => rolesOf(ctx)?.background.overrides[key] ?? null,
		write: (pick) =>
			updateRoles((roles) => {
				const { [key]: _old, ...overrides } = roles.background.overrides
				return {
					...roles,
					background: { ...roles.background, overrides: pick ? { ...overrides, [key]: pick } : overrides },
				}
			}),
		format: (pick) => (pick ? "Its own model" : "Same as Background text"),
	})

export const MODELS_ROWS: readonly SettingsRow[] = [
	state({
		id: "models.chat",
		label: "Chat",
		description: "New threads start here. Each thread can change it from the composer.",
		aliases: ["default model", "thread model", "act"],
	}),
	preference<SubagentPick>({
		id: "models.subagents",
		label: "Subagents",
		aliases: ["helpers", "what helpers run on", "default subagent model"],
		mirrorOf: "subagents.default",
		defaultValue: () => ({ kind: "thread", level: "inherit" }),
		read: (ctx) => rolesOf(ctx)?.subagents ?? { kind: "thread", level: "inherit" },
		write: (subagents) => updateRoles((roles) => ({ ...roles, subagents })),
	}),
	state({
		id: "models.background",
		label: "Background text",
		description: "Thread titles, commit messages and walkthrough Generate.",
		aliases: ["titles", "commit messages", "source control"],
	}),
	preference<boolean>({
		id: "models.background.titles-enabled",
		label: "Generate thread titles",
		description: "Off by default: each title costs a model call.",
		aliases: ["title", "name", "background text"],
		defaultValue: () => false,
		read: (ctx) => rolesOf(ctx)?.background.titlesEnabled ?? false,
		write: (titlesEnabled) => updateRoles((roles) => ({ ...roles, background: { ...roles.background, titlesEnabled } })),
	}),
	state({
		id: "models.advanced",
		label: "Models: Advanced",
		description: "Different model for Ask, background text one by one, request timeout.",
		// There's nothing to pick from until a model exists.
		visible: (ctx) => (ctx.state.modelSettings?.settings.models.length ?? 0) > 0,
	}),
	preference<RoleSettings["ask"]>({
		id: "models.ask",
		parent: "models.advanced",
		label: "Different model for Ask",
		description: "When the composer is on Ask.",
		aliases: ["plan", "ask model", "separate"],
		defaultValue: () => ({ enabled: false, pick: null }),
		read: (ctx) => rolesOf(ctx)?.ask ?? { enabled: false, pick: null },
		write: (ask) => updateRoles((roles) => ({ ...roles, ask })),
		// Switched off, the pick it keeps is only there for switching back on.
		isOverride: (ctx) => rolesOf(ctx)?.ask.enabled ?? false,
		format: (ask) => (ask.enabled ? "Its own model" : "Same as Chat"),
	}),
	useOverride("commitMessages", "models.background.commit-messages", "Commit messages", [
		"source control",
		"git",
		"background text",
	]),
	useOverride("generate", "models.background.generate", "Walkthrough Generate", ["walkthrough", "profiles", "background text"]),
	useOverride("titles", "models.background.titles", "Thread titles", ["title model", "name", "background text"]),
	preference<number | null>({
		id: "models.timeout",
		parent: "models.advanced",
		label: "Request timeout",
		description: "Seconds before a model request gives up. A connection can set its own.",
		aliases: ["timeout", "seconds"],
		defaultValue: () => null,
		read: (ctx) => ctx.state.modelSettings?.settings.requestTimeoutMs ?? null,
		write: (requestTimeoutMs) => updateRoles((roles) => roles, { requestTimeoutMs }),
		format: (value) => (value == null ? "Default" : `${value / 1000}s`),
	}),
	state({
		id: "models.connections",
		label: "Set-up models",
		description: "Every model you've set up, under its connection. Base URLs, API keys, levels, prices.",
		aliases: [
			"models",
			"connections",
			"provider",
			"api key",
			"base url",
			"openai",
			"compatible",
			"azure",
			"headers",
			"bedrock",
			"ollama",
			"context window",
			"reasoning",
			"levels",
			"temperature",
			"verbosity",
			"price",
			"shared defaults",
			"duplicate",
		],
		managedKeys: PROVIDER_MANAGED_KEYS,
	}),
	action({
		id: "models.add-connection",
		label: "Add a connection",
		description: "A base URL and key, for any server that speaks the OpenAI API.",
		aliases: ["openai compatible", "gateway", "vllm", "litellm", "azure", "endpoint"],
	}),
	action({
		id: "models.add-provider",
		label: "Add a model from another provider",
		description: "Anthropic, Bedrock, Vertex, OpenRouter, Ollama and the rest of the catalog.",
		aliases: ["provider", "anthropic", "bedrock", "vertex", "gemini", "openrouter", "ollama", "lm studio", "sign in"],
	}),
]
