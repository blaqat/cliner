import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { updateSetting } from "../utils/settingsHandlers"
import { stored, preference, action, state, onlyWithVsCodeTerminal } from "../shell/rowFactories"
import { StateServiceClient } from "@/services/grpc-client"
export const TOOLS_ROWS = [
	action({
		id: "tools.rules",
		label: "Rules, workflows and skills",
		description: "Manage instructions and automation in the existing overlay.",
	}),
	stored("mcpMarketplaceEnabled", true, { id: "tools.mcp.marketplace", parent: "tools.mcp", label: "MCP marketplace" }),
	stored("mcpResponsesCollapsed", false, { id: "tools.mcp.collapsed", parent: "tools.mcp", label: "Collapse responses" }),
	preference<boolean>({
		id: "tools.browser",
		label: "Browser",
		description: "Let Cline open pages in headless Chrome.",
		defaultValue: () => false,
		read: (ctx) => !(ctx.state.browserSettings ?? DEFAULT_BROWSER_SETTINGS).disableToolUse,
		write: (on, ctx) => updateSetting("browserSettings", { ...ctx.state.browserSettings, disableToolUse: !on }),
	}),
	...(
		[
			["chromeExecutablePath", "Chrome path", "Empty uses the Chromium Cline downloads."],
			["customArgs", "Chrome arguments", "Extra launch arguments."],
			["remoteBrowserHost", "Remote host", "The debugging URL of your running Chrome."],
		] as const
	).map(([key, label, description]) =>
		preference<string>({
			id: `tools.browser.${key}`,
			parent: "tools.browser",
			label,
			description,
			defaultValue: () => DEFAULT_BROWSER_SETTINGS[key] ?? "",
			read: (ctx) => (ctx.state.browserSettings ?? DEFAULT_BROWSER_SETTINGS)[key] ?? "",
			write: (value, ctx) => updateSetting("browserSettings", { ...ctx.state.browserSettings, [key]: value }),
		}),
	),
	preference<boolean>({
		id: "tools.browser.remote",
		parent: "tools.browser",
		label: "Remote browser",
		description: "Connect to a Chrome that is already running.",
		defaultValue: () => false,
		read: (ctx) => !!(ctx.state.browserSettings ?? DEFAULT_BROWSER_SETTINGS).remoteBrowserEnabled,
		write: (remoteBrowserEnabled, ctx) =>
			updateSetting("browserSettings", { ...ctx.state.browserSettings, remoteBrowserEnabled }),
	}),
	preference<string>({
		id: "tools.browser.viewport",
		parent: "tools.browser",
		label: "Viewport",
		defaultValue: () => "900x600",
		read: (ctx) =>
			`${(ctx.state.browserSettings ?? DEFAULT_BROWSER_SETTINGS).viewport.width}x${(ctx.state.browserSettings ?? DEFAULT_BROWSER_SETTINGS).viewport.height}`,
		write: (value, ctx) => {
			const [width, height] = value.split("x").map(Number)
			updateSetting("browserSettings", { ...ctx.state.browserSettings, viewport: { width, height } })
		},
	}),
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
]
