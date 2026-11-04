export const featureSettingElementId = (featureId: string) => `${featureId}-setting`
export const featureSettingControlId = (featureId: string) => `${featureSettingElementId(featureId)}-control`

export const SETTINGS_PAGE_IDS = ["models", "agent", "subagents", "tools", "layout", "data", "about", "debug"] as const
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number]
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "models"

/** A row's id starts with its page's id: `tools.terminal.reuse` lives on Tools. */
export type SettingsRowId = `${SettingsPageId}.${string}`

export type SettingsNavigationTarget =
	| keyof typeof SETTINGS_TARGET_REDIRECTS
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

/**
 * Old targets, from callers and from navigation history, and where each lands in the shell.
 * Page and row ids pass through as they are.
 */
export const SETTINGS_TARGET_REDIRECTS = {
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
} as const satisfies Readonly<Record<string, SettingsPageId | SettingsRowId>>

export const settingsRowElementId = (rowId: string) => `setting-${rowId.replaceAll(".", "-")}`
export const settingsRowControlId = (rowId: string) => `${settingsRowElementId(rowId)}-control`

/** Anchors the Models page puts on what a fix link names. A model's `levels` anchor focuses a real control. */
export const settingsModelElementId = (modelId: string, field?: string) =>
	field ? `settings-model-${modelId}-${field}` : `settings-model-${modelId}`
export const settingsConnectionElementId = (connectionId: string) => `settings-connection-${connectionId}`
export const settingsRoleElementId = (role: string) => `settings-role-${role}`

/** Role names a `role:` fix link can use, and the row each one opens. */
const ROLE_TARGET_ROWS: Readonly<Record<string, SettingsRowId>> = {
	chat: "models.chat",
	ask: "models.ask",
	subagents: "models.subagents",
	background: "models.background",
	titles: "models.background.titles",
	commitMessages: "models.background.commit-messages",
	generate: "models.background.generate",
}

/** The host's structured fix target, as the string the shell parses. */
export const settingsTargetFromHost = (target: {
	page?: string
	modelId?: string
	field?: string
	connectionId?: string
	role?: string
}) => {
	if (target.modelId) {
		return target.field ? (`model:${target.modelId}:${target.field}` as const) : (`model:${target.modelId}` as const)
	}
	if (target.connectionId) {
		return `connection:${target.connectionId}` as const
	}
	if (target.role) {
		return `role:${target.role}` as const
	}
	return "models" as const
}

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
	const canonical: string = SETTINGS_TARGET_REDIRECTS[target as keyof typeof SETTINGS_TARGET_REDIRECTS] ?? target
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
			const elementId = settingsConnectionElementId(rest)
			return { pageId: "models", elementId, focusElementId: `${elementId}-control` }
		}
		if (kind === "role") {
			const rowId = ROLE_TARGET_ROWS[rest]
			return rowId ? { pageId: "models", rowId } : { pageId: "models", elementId: settingsRoleElementId(rest) }
		}
	}
	const prefix = canonical.split(".")[0]
	return isPageId(prefix) ? { pageId: prefix, rowId: canonical } : { elementId: canonical }
}

/** The page a target opens, before the shell applies its dev and admin gates. */
export const settingsPageForTarget = (target: string | undefined): SettingsPageId | undefined =>
	parseSettingsTarget(target)?.pageId
