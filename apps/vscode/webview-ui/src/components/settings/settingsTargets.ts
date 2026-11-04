export const featureSettingElementId = (featureId: string) => `${featureId}-setting`
export const featureSettingControlId = (featureId: string) => `${featureSettingElementId(featureId)}-control`

export const SETTINGS_NAVIGATION_TARGETS = {
	"api-config": { tabId: "api-config" },
	profiles: { tabId: "profiles" },
	features: { tabId: "features" },
	subagents: { tabId: "subagents" },
	checkpoints: {
		tabId: "features",
		elementId: featureSettingElementId("checkpoints"),
		focusElementId: featureSettingControlId("checkpoints"),
	},
	worktrees: { tabId: "features", elementId: "worktree-features" },
	terminal: { tabId: "terminal" },
	general: { tabId: "general" },
	about: { tabId: "about" },
	debug: { tabId: "debug" },
	"remote-config": { tabId: "remote-config" },
	// Named for where the shell sends them; on the old tabs they keep today's destination.
	"mcp-advanced": { tabId: "features" },
	reporting: { tabId: "general" },
	"enter-sends-as": { tabId: "general" },
} as const

export const SETTINGS_PAGE_IDS = ["models", "agent", "subagents", "tools", "layout", "data", "about", "debug"] as const
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number]
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "models"

/** A row's id starts with its page's id: `tools.terminal.reuse` lives on Tools. */
export type SettingsRowId = `${SettingsPageId}.${string}`

export type SettingsNavigationTarget =
	| keyof typeof SETTINGS_NAVIGATION_TARGETS
	| SettingsPageId
	| SettingsRowId
	| `model:${string}`
	| `connection:${string}`
	| `role:${string}`

export interface SettingsNavigationRequest {
	target: SettingsNavigationTarget
	requestId: number
}

let nextSettingsNavigationRequestId = 0

export const getNextSettingsNavigationRequestId = () => ++nextSettingsNavigationRequestId

export const createSettingsNavigationRequest = (target: SettingsNavigationTarget): SettingsNavigationRequest => ({
	target,
	requestId: getNextSettingsNavigationRequestId(),
})

export interface ResolvedSettingsTarget {
	tabId?: string
	elementId?: string
	focusElementId?: string
}

export const resolveSettingsTarget = (target: string | undefined): ResolvedSettingsTarget | undefined => {
	if (!target) {
		return undefined
	}
	return SETTINGS_NAVIGATION_TARGETS[target as keyof typeof SETTINGS_NAVIGATION_TARGETS] ?? { elementId: target }
}

/**
 * Old targets, from callers and from navigation history, and where each lands in the shell.
 * Page and row ids pass through as they are.
 */
export const SETTINGS_TARGET_REDIRECTS: Readonly<Record<string, SettingsPageId | SettingsRowId>> = {
	"api-config": "models",
	profiles: "models.background.generate",
	features: "agent",
	"mcp-advanced": "tools.mcp.display",
	checkpoints: "agent.checkpoints",
	worktrees: "tools.worktrees",
	terminal: "tools.terminal",
	general: "agent.language",
	reporting: "data.reporting",
	"enter-sends-as": "layout.enter",
	"remote-config": "about.remote-config",
}

export const settingsRowElementId = (rowId: string) => `setting-${rowId.replaceAll(".", "-")}`
export const settingsRowControlId = (rowId: string) => `${settingsRowElementId(rowId)}-control`

/** Anchors the Models page puts on what a fix link names. A model's `levels` anchor focuses a real control. */
export const settingsModelElementId = (modelId: string, field?: string) =>
	field ? `settings-model-${modelId}-${field}` : `settings-model-${modelId}`
export const settingsConnectionElementId = (connectionId: string) => `settings-connection-${connectionId}`
export const settingsRoleElementId = (role: string) => `settings-role-${role}`

export interface ParsedSettingsTarget {
	pageId?: SettingsPageId
	rowId?: string
	elementId?: string
	focusElementId?: string
}

const isPageId = (value: string): value is SettingsPageId => (SETTINGS_PAGE_IDS as readonly string[]).includes(value)

/** The shell's reading of a target. Anything it doesn't recognize is an element on the current page. */
export const parseSettingsTarget = (target: string | undefined): ParsedSettingsTarget | undefined => {
	if (!target) {
		return undefined
	}
	const canonical: string = SETTINGS_TARGET_REDIRECTS[target] ?? target
	if (isPageId(canonical)) {
		return { pageId: canonical }
	}
	const separator = canonical.indexOf(":")
	if (separator > 0) {
		const kind = canonical.slice(0, separator)
		const rest = canonical.slice(separator + 1)
		if (kind === "model") {
			const [modelId, field] = rest.split(":")
			const elementId = settingsModelElementId(modelId, field)
			return { pageId: "models", elementId, focusElementId: field ? `${elementId}-control` : undefined }
		}
		if (kind === "connection") {
			return { pageId: "models", elementId: settingsConnectionElementId(rest) }
		}
		if (kind === "role") {
			return { pageId: "models", elementId: settingsRoleElementId(rest) }
		}
	}
	const prefix = canonical.split(".")[0]
	return isPageId(prefix) ? { pageId: prefix, rowId: canonical } : { elementId: canonical }
}

/** The page a target opens, before the shell applies its dev and admin gates. */
export const settingsPageForTarget = (target: string | undefined): SettingsPageId | undefined =>
	parseSettingsTarget(target)?.pageId
