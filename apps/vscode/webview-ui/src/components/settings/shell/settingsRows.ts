import { ABOUT_ROWS } from "../about/aboutRows"
import { DATA_ROWS } from "../data/dataRows"
import { LAYOUT_ROWS } from "../layout/layoutRows"
import { TOOLS_ROWS } from "../tools/toolsRows"
import { SUBAGENTS_ROWS } from "../subagents/subagentsRows"
import { AGENT_ROWS } from "../agent/agentRows"
import { state, action } from "./rowFactories"
import type { SettingsRow } from "./settingsRegistry"
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
/**
 * Every row search, Changed and navigation can reach. Values stay in their existing stores: this
 * only says how to read, write and reset them. A row here must exist on its page.
 */
export const SETTINGS_ROWS: readonly SettingsRow[] = [
	state({
		id: "models.connections",
		label: "Models and connections",
		description: "Providers, API keys, base URLs and the models they offer.",
		aliases: ["provider", "api key", "base url", "openai", "compatible", "azure", "headers", "bedrock", "ollama"],
		managedKeys: PROVIDER_MANAGED_KEYS,
	}),
	state({
		id: "models.background",
		label: "Background text",
		description: "The model for thread titles, commit messages and Generate.",
		aliases: ["titles", "commit messages"],
	}),
	state({
		id: "models.background.generate",
		parent: "models.background",
		label: "Generate",
		description: "Which model each use of background text runs on.",
		aliases: ["walkthrough", "thread titles", "commit messages", "profiles", "subagent default"],
	}),

	...AGENT_ROWS,

	...SUBAGENTS_ROWS,

	...TOOLS_ROWS,

	...LAYOUT_ROWS,

	...DATA_ROWS,

	...ABOUT_ROWS,

	action({
		id: "debug.tools",
		label: "Debug tools",
		description: "Reset workspace, global and onboarding state.",
	}),
]
