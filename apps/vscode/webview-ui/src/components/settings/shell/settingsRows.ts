import { createDefaultModelSettings, type SubagentPolicy } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { ModelSettingsRequestV1 } from "@shared/proto/cline/models"
import type { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { isAdminOrOwner } from "@/components/account/helpers"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { detectMetaKeyChar, detectOS } from "@/utils/platformUtils"
import { DEFAULT_TOAST_SECONDS } from "../../toasts/threadToastRules"
import type { SettingsPageId } from "../settingsTargets"
import { updateSetting } from "../utils/settingsHandlers"
import type { InfoRow, PreferenceRow, SettingsRow, SettingsRowContext } from "./settingsRegistry"

type RowFields<R extends SettingsRow> = Omit<R, "page" | "kind">
type StoredFields<T> = Omit<RowFields<PreferenceRow<T>>, "defaultValue" | "read" | "write">

const pageOf = (id: string) => id.split(".")[0] as SettingsPageId

const preference = <T>(row: RowFields<PreferenceRow<T>>) =>
	({ ...row, page: pageOf(row.id), kind: "preference" }) as PreferenceRow as SettingsRow

/** A preference stored as one `UpdateSettingsRequest` field and published under the same name. */
const stored = <T>(key: keyof UpdateSettingsRequest & keyof ExtensionStateContextType, fallback: T, row: StoredFields<T>) =>
	preference<T>({
		...row,
		defaultValue: () => fallback,
		read: (ctx) => (ctx.state[key] ?? fallback) as T,
		write: (value) => updateSetting(key, value),
	})

const action = (row: RowFields<InfoRow>): SettingsRow => ({ ...row, page: pageOf(row.id), kind: "action" })
const state = (row: RowFields<InfoRow>): SettingsRow => ({ ...row, page: pageOf(row.id), kind: "state" })

const POLICY_DEFAULTS = createDefaultModelSettings().subagents

/** Revision-checked against the latest store, not the last published copy. */
const updateSubagentPolicy = async (change: (policy: SubagentPolicy) => SubagentPolicy) => {
	const response = await ModelsServiceClient.getModelSettings(ModelSettingsRequestV1.create({ json: "{}" }))
	const latest = JSON.parse(response.json) as ModelSettingsState
	await ModelsServiceClient.setSubagentPolicy(
		ModelSettingsRequestV1.create({
			json: JSON.stringify({ expectedRevision: latest.settings.revision, subagents: change(latest.settings.subagents) }),
		}),
	)
}

const policyOf = (ctx: SettingsRowContext) => ctx.state.modelSettings?.settings.subagents ?? POLICY_DEFAULTS
const onlyWithSubagents = (ctx: SettingsRowContext) => (policyOf(ctx).enabled ? undefined : "Only with Subagents on.")

const SUBAGENT_ACCESS = [
	["write", "Edit files", "Let subagents edit files in Act.", "subagentsAllowWrite", "write"],
	["commands", "Commands", "Let subagents run shell commands.", "subagentsAllowCommands", "shell terminal"],
	["web", "Web", "Let subagents use the web.", "subagentsAllowWeb", "internet search fetch"],
	["mcp", "MCP tools", "Let subagents use MCP tools.", "subagentsAllowMcp", "servers"],
] as const

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

const backgroundExec = (ctx: SettingsRowContext) => ctx.state.vscodeTerminalExecutionMode === "backgroundExec"
const onlyWithVsCodeTerminal = (ctx: SettingsRowContext) => (backgroundExec(ctx) ? "Only with the VS Code terminal." : undefined)

const TELEMETRY_LABELS: Record<string, string> = { enabled: "On", disabled: "Off", unset: "Not chosen" }

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

	stored("preferredLanguage", "English", {
		id: "agent.language",
		label: "Language",
		description: "The language Cline answers in.",
		aliases: ["preferred language", "locale"],
	}),
	stored("enableCheckpointsSetting", true, {
		id: "agent.checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback.",
		aliases: ["restore", "rollback", "undo"],
	}),
	stored("backgroundEditEnabled", false, {
		id: "agent.background-edit",
		label: "Background edit",
		description: "Edit without taking editor focus.",
		aliases: ["focus"],
	}),
	stored("useAutoCondense", true, {
		id: "agent.compact",
		label: "Automatic compaction",
		description: "Compress the conversation when it gets long. Off: only when you ask.",
		aliases: ["auto compact", "condense", "context", "manual"],
	}),
	stored("compactionStrategy", "agentic", {
		id: "agent.compact.strategy",
		parent: "agent.compact",
		label: "Compaction strategy",
		description: "How compaction rewrites the conversation.",
		aliases: ["basic", "agentic"],
		format: (value) => (value === "basic" ? "Basic" : "Agentic"),
		disabledReason: (ctx) => (ctx.state.useAutoCondense === false ? "Only with Automatic compaction on." : undefined),
	}),
	stored("continueAnswerOnActSwitch", true, {
		id: "agent.continue-on-act",
		label: "Carry out the answer when switching to Act",
		description: "Right after an Ask answer, switching to Act also carries it out. Off: switching only changes the mode.",
		aliases: ["ask", "plan", "continue"],
	}),

	preference<boolean>({
		id: "subagents.enabled",
		label: "Subagents",
		description: "Let a thread start helpers that inherit your model and settings.",
		aliases: ["enable", "spawn", "helpers", "delegate"],
		managedKeys: ["subagentsEnabled"],
		defaultValue: () => POLICY_DEFAULTS.enabled,
		read: (ctx) => policyOf(ctx).enabled,
		write: (value) => updateSubagentPolicy((policy) => ({ ...policy, enabled: value })),
	}),
	preference<number>({
		id: "subagents.cap",
		label: "At most, per thread",
		description: "How many can run at once, nested ones included. Past it the parent is told to wait.",
		aliases: ["cap", "limit", "maximum", "concurrent"],
		managedKeys: ["subagentsMaxConcurrent"],
		defaultValue: () => POLICY_DEFAULTS.maxConcurrent,
		read: (ctx) => policyOf(ctx).maxConcurrent,
		write: (value) => updateSubagentPolicy((policy) => ({ ...policy, maxConcurrent: value })),
		format: (value) => (value === 0 ? "Unlimited" : String(value)),
		disabledReason: onlyWithSubagents,
	}),
	...SUBAGENT_ACCESS.map(([key, label, description, managedKey, aliases]) =>
		preference<boolean>({
			id: `subagents.access.${key}`,
			label,
			description,
			aliases: ["access", "permissions", aliases],
			managedKeys: [managedKey],
			defaultValue: () => POLICY_DEFAULTS.access[key],
			read: (ctx) => policyOf(ctx).access[key],
			write: (value) => updateSubagentPolicy((policy) => ({ ...policy, access: { ...policy.access, [key]: value } })),
			disabledReason: onlyWithSubagents,
		}),
	),

	action({
		id: "tools.mcp",
		label: "MCP servers",
		description: "Add and configure the servers Cline can use.",
		aliases: ["marketplace", "rules", "workflows", "skills"],
	}),
	stored("mcpDisplayMode", "plain", {
		id: "tools.mcp.display",
		parent: "tools.mcp",
		label: "How results show",
		description: "How MCP responses appear in a thread.",
		aliases: ["display mode", "rich", "markdown", "plain"],
		format: (value) =>
			({ plain: "Plain text", rich: "Rich display", markdown: "Markdown" })[value as string] ?? String(value),
	}),
	stored("webSearchEnabled", true, {
		id: "tools.web-search",
		label: "Web search",
		description: "Let the model search the web when its provider supports it. Applies to new tasks.",
		aliases: ["internet", "browse"],
	}),
	stored("defaultTerminalProfile", "default", {
		id: "tools.terminal",
		label: "Terminal",
		description: "The shell Cline runs commands in. Default follows VS Code.",
		aliases: ["shell", "zsh", "bash", "profile", "powershell"],
	}),
	stored("vscodeTerminalExecutionMode", "vscodeTerminal", {
		id: "tools.terminal.mode",
		parent: "tools.terminal",
		label: "Where commands run",
		description: "The VS Code terminal or a background process.",
		aliases: ["execution mode", "background exec"],
		format: (value) => (value === "backgroundExec" ? "Background" : "VS Code terminal"),
	}),
	preference<number>({
		id: "tools.terminal.wait",
		parent: "tools.terminal",
		label: "Shell integration wait",
		description: "Seconds to wait for shell integration before running a command.",
		aliases: ["timeout"],
		defaultValue: () => 4000,
		read: (ctx) => ctx.state.shellIntegrationTimeout ?? 4000,
		write: async (timeoutMs) => {
			await StateServiceClient.updateTerminalConnectionTimeout({ timeoutMs })
		},
		format: (value) => `${value / 1000}s`,
		disabledReason: onlyWithVsCodeTerminal,
	}),
	stored("terminalReuseEnabled", true, {
		id: "tools.terminal.reuse",
		parent: "tools.terminal",
		label: "Reuse terminals",
		description: "Reuse terminals that aren't in the working directory. Turn off if commands get stuck.",
		aliases: ["aggressive"],
		disabledReason: onlyWithVsCodeTerminal,
	}),
	state({
		id: "tools.terminal.env",
		parent: "tools.terminal",
		label: "Environment variables",
		description: "Variables, env files and PATH, for every repo or just this one.",
		aliases: ["env", "path", "workspace", "per repo"],
	}),
	state({
		id: "tools.worktrees",
		label: "Worktrees",
		description: "Start threads in their own worktree.",
		aliases: ["git", "mm", "branch"],
		focusElementId: "worktrees-mode",
	}),
	stored("hooksEnabled", true, {
		id: "tools.hooks",
		label: "Hooks",
		description: "Run lifecycle and tool hooks during a task.",
	}),

	stored("oneViewEnabled", false, {
		id: "layout.one-view",
		label: "One view",
		description: "Show your threads beside the chat instead of on a separate home page.",
		aliases: ["list", "side bar", "tab bar", "classic"],
	}),
	stored("enterSendsAs", "steer", {
		id: "layout.enter",
		label: "While working, Enter sends as",
		description: (ctx) =>
			`${detectMetaKeyChar(ctx.state.platform)}+Enter does the other one. ${detectOS(ctx.state.platform) === "mac" ? "⌥" : "Alt"}+Enter sends as an aside.`,
		aliases: ["steer", "interject"],
		format: (value) => (value === "interject" ? "Interject" : "Steer"),
	}),
	stored("threadToastsEnabled", true, {
		id: "layout.toasts",
		label: "Toasts",
		description: "When a thread you're not viewing finishes or needs you.",
		aliases: ["notifications", "in-app"],
	}),
	stored("threadToastSeconds", DEFAULT_TOAST_SECONDS, {
		id: "layout.toasts.seconds",
		parent: "layout.toasts",
		label: "Completion toast seconds",
		description: "Hovering pauses it. While VS Code is in the background, the timer waits.",
		aliases: ["duration"],
		disabledReason: (ctx) => (ctx.state.threadToastsEnabled === false ? "Only with Toasts on." : undefined),
	}),
	stored("showFeatureTips", false, {
		id: "layout.tips",
		label: "Feature tips",
		description: "Rotating tips while Cline is thinking.",
	}),

	stored<string>("telemetrySetting", "unset", {
		id: "data.reporting",
		label: "Error and usage reporting",
		description: "Help improve Cline. No code, prompts or personal information are ever sent.",
		aliases: ["telemetry", "privacy", "analytics"],
		managedKeys: ["telemetrySetting"],
		format: (value) => TELEMETRY_LABELS[value] ?? value,
	}),

	state({
		id: "about.info",
		label: "Cline",
		description: "Version, what's new, shortcuts and links.",
		aliases: ["version", "release notes", "shortcuts", "help"],
	}),
	state({
		id: "about.remote-config",
		parent: "about.info",
		label: "Remote Config",
		description: "What your organization manages, and opting out.",
		aliases: ["organization", "admin", "opentelemetry", "prompt uploading"],
		visible: (ctx) => !!ctx.activeOrganization && isAdminOrOwner(ctx.activeOrganization),
	}),

	action({
		id: "debug.tools",
		label: "Debug tools",
		description: "Reset workspace, global and onboarding state.",
	}),
]
