import {
	BUILTIN_MODEL_VALUES,
	type Connection,
	type ConnectionPatch,
	type MigratedValue,
	type ModelLevel,
	type ModelPick,
	type ModelRow,
	type ModelSettings,
	type ModelValues,
	type RoleSettings,
	resolveModelValues,
} from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { settingsModelElementId } from "../settingsTargets"

export type Effective = ModelSettingsState["effective"][string]

/** The Connection type's secret field for a compatible key, and the prefix every reference shares. */
/** The field a saved secret reference names; a moved header's differs from one locked here. */
export const secretField = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1)
export const secretRef = (connectionId: string, field: string) => `settings:v1:connection:${connectionId}:${field}`

export const newId = () => crypto.randomUUID()

export const modelName = (row: Pick<ModelRow, "name" | "upstreamId">) => row.name || row.upstreamId || "New model"

export const hostOf = (url: string | null | undefined) => {
	if (!url) {
		return "the server"
	}
	try {
		return new URL(url).host
	} catch {
		return url.replace(/^https?:\/\//, "").split("/")[0] || "the server"
	}
}

export const isValidUrl = (text: string) => {
	try {
		const { protocol } = new URL(text)
		return protocol === "http:" || protocol === "https:"
	} catch {
		return false
	}
}

export const isAzureUrl = (url: string | null | undefined) => !!url && /\.azure\.com|\.azure-api\.net/i.test(url)

export const connectionName = (connection: Connection, providerName?: string) =>
	connection.name || providerName || (connection.kind === "provider" ? connection.providerId : hostOf(connection.baseUrl))

export const formatTokens = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}K` : String(value))

/** Levels offered by every new model that says it can reason. Lowest first; ids double as the wire value. */
export const STANDARD_LADDER: ModelLevel[] = [
	{ id: "default", label: "Default", rank: 0, request: { kind: "default" } },
	{ id: "low", label: "Low", rank: 1, request: { kind: "effort", value: "low" } },
	{ id: "medium", label: "Medium", rank: 2, request: { kind: "effort", value: "medium" } },
	{ id: "high", label: "High", rank: 3, request: { kind: "effort", value: "high" } },
	{ id: "xhigh", label: "XHigh", rank: 4, request: { kind: "effort", value: "xhigh" } },
]

/** What a new "can reason" model offers until someone says otherwise: Default and Low to High. */
export const DEFAULT_OFFERED: ModelLevel[] = STANDARD_LADDER.slice(0, 4)

/** A level picks up its label for display; imported levels can be plain tokens. */
export const levelTitle = (label: string) => {
	if (label !== label.toLowerCase()) {
		return label
	}
	return label === "xhigh" ? "XHigh" : label.charAt(0).toUpperCase() + label.slice(1)
}

/** Standard rows first so the table doesn't shift, then whatever else this model offers, in rank order. */
export const levelTableRows = (levels: ModelLevel[]): { level: ModelLevel; offered: boolean }[] => {
	const offered = new Map(levels.map((level) => [level.id, level]))
	const standard = STANDARD_LADDER.map((level) => ({ level: offered.get(level.id) ?? level, offered: offered.has(level.id) }))
	const others = levels
		.filter((level) => !STANDARD_LADDER.some((candidate) => candidate.id === level.id))
		.sort((a, b) => a.rank - b.rank)
		.map((level) => ({ level, offered: true }))
	return [...standard, ...others]
}

export const levelRange = (effective: Effective | undefined): string => {
	const reasoning = effective?.reasoning.value ?? "unknown"
	if (reasoning === "unknown") {
		return "Levels unknown"
	}
	if (reasoning === "no") {
		return "No levels"
	}
	const ordered = [...(effective?.levels.value ?? [])].sort((a, b) => a.rank - b.rank).filter((level) => level.id !== "default")
	if (!ordered.length) {
		return "No levels on"
	}
	if (ordered.length === 1) {
		return `${levelTitle(ordered[0].label)} only`
	}
	const ranks = ordered.map((level) => level.rank)
	const contiguous = ranks[ranks.length - 1] - ranks[0] === ranks.length - 1
	return contiguous
		? `${levelTitle(ordered[0].label)}–${levelTitle(ordered[ordered.length - 1].label)}`
		: ordered.map((level) => levelTitle(level.label)).join(", ")
}

export const priceSummary = (effective: Effective | undefined) => {
	const input = effective?.inputPrice.value
	const output = effective?.outputPrice.value
	return input == null || output == null ? "" : `$${input} / $${output}`
}

/** Keys belong to the connection, so a missing one shows there once, not on every model or pick. */
export const KEY_MISSING = /credentials are missing/i
export const ENV_EMPTY = /environment variable/i

export const connectionProblem = (
	availability: { available: boolean; reason?: string; target?: { field?: string } } | undefined,
): string | undefined => {
	if (!availability || availability.available) {
		return undefined
	}
	const reason = availability.reason ?? ""
	return KEY_MISSING.test(reason)
		? "key missing"
		: ENV_EMPTY.test(reason)
			? "env var empty"
			: availability.target?.field === "baseUrl"
				? "base URL isn't valid"
				: undefined
}

export const listWords = (words: string[]) =>
	words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`

/** "Shared defaults" summary line. */
export const sharedSummary = (defaults: Connection["defaults"]) => {
	const parts: string[] = []
	if (defaults.contextWindow != null) {
		parts.push(formatTokens(defaults.contextWindow))
	}
	if (defaults.reasoning === "yes" && defaults.levels) {
		const range = levelRange({
			...resolveModelValues({}, undefined, defaults),
		})
		if (range !== "Levels unknown") {
			parts.push(range)
		}
	}
	if (defaults.free) {
		parts.push("free")
	} else if (defaults.inputPrice != null && defaults.outputPrice != null) {
		parts.push(`$${defaults.inputPrice} / $${defaults.outputPrice}`)
	}
	if (defaults.temperature != null) {
		parts.push(`temp ${defaults.temperature}`)
	}
	return parts.length ? parts.join(" · ") : "none set"
}

/**
 * A change to a connection's shared defaults as a patch. Empty (null) and Unknown clear the key, so models
 * go back to inheriting; false and zero are answers and stay.
 */
export const sharedDefaultsPatch = (connectionId: string, change: Partial<ModelValues>): ConnectionPatch => {
	const entries = Object.entries(change)
	const cleared = entries.filter(([, value]) => value === null || value === "unknown").map(([key]) => key)
	const set = entries.filter(([key]) => !cleared.includes(key))
	return {
		id: connectionId,
		...(set.length ? { defaults: Object.fromEntries(set) } : {}),
		...(cleared.length ? { remove: { defaults: cleared as (keyof ModelValues)[] } } : {}),
	}
}

const BUILTIN = BUILTIN_MODEL_VALUES as Record<string, unknown>

/** A shared default that says something, as opposed to one spelling out the builtin value. */
export const hasSharedValue = (defaults: Connection["defaults"], key: keyof ModelValues) =>
	Object.hasOwn(defaults, key) && JSON.stringify(defaults[key]) !== JSON.stringify(BUILTIN[key])

/** A model overrides this field on purpose. */
export const hasOverride = (row: ModelRow, key: keyof ModelValues) => Object.hasOwn(row.overrides, key)

/** Changed + Reset: a value of its own where the connection shares one. Reset deletes it, so it follows again. */
export const overridesShared = (row: ModelRow, connection: Connection, key: keyof ModelValues) =>
	hasOverride(row, key) && hasSharedValue(connection.defaults, key) && !row.migratedValues?.includes(key as MigratedValue)

export const withoutOverride = (row: ModelRow, key: keyof ModelValues): ModelRow => {
	const { [key]: _removed, ...overrides } = row.overrides
	return { ...row, overrides }
}

export const withOverride = <K extends keyof ModelValues>(row: ModelRow, key: K, value: ModelValues[K]): ModelRow => ({
	...row,
	overrides: { ...row.overrides, [key]: value },
})

/** IDs out of a pasted list: one per line, or separated by commas or spaces. Order kept, repeats dropped. */
export const parseModelIds = (text: string) => [
	...new Set(
		text
			.split(/[\s,]+/)
			.map((id) => id.trim())
			.filter(Boolean),
	),
]

export const newModelRow = (
	connectionId: string,
	upstreamId: string,
	name = "",
	kind: ModelRow["kind"] = "unknown",
): ModelRow => ({
	id: newId(),
	connectionId,
	upstreamId,
	name: name === upstreamId ? "" : name,
	kind,
	overrides: {},
	providerOptions: {},
})

/** The pick used to test or preview a model: its strongest level, so the mapping shows. */
export const previewPick = (row: ModelRow, effective: Effective | undefined): ModelPick => {
	if (effective?.reasoning.value !== "yes") {
		return { modelId: row.id, levelId: "default" }
	}
	const levels = [...effective.levels.value].sort((a, b) => a.rank - b.rank)
	return { modelId: row.id, levelId: levels[levels.length - 1]?.id ?? "default" }
}

export type RoleKey = "chat" | "ask" | "subagents" | "background" | "titles" | "commitMessages" | "generate"

export const ROLE_LABELS: Record<RoleKey, string> = {
	chat: "Chat",
	ask: "Different model for Ask",
	subagents: "Subagents",
	background: "Background text",
	titles: "Thread titles",
	commitMessages: "Commit messages",
	generate: "Walkthrough Generate",
}

export const roleRowId: Record<RoleKey, string> = {
	chat: "models.chat",
	ask: "models.ask",
	subagents: "models.subagents",
	background: "models.background",
	titles: "models.background.titles",
	commitMessages: "models.background.commit-messages",
	generate: "models.background.generate",
}

export const rolePick = (roles: RoleSettings, role: RoleKey): ModelPick | null => {
	switch (role) {
		case "chat":
			return roles.chat
		case "ask":
			return roles.ask.enabled ? roles.ask.pick : null
		case "subagents":
			return roles.subagents.kind === "model" ? roles.subagents.pick : null
		case "background":
			return roles.background.pick
		default:
			return roles.background.overrides[role] ?? null
	}
}

/** Takes a role off whatever it points at: Chat and Background text go blank, the rest go back to following. */
export const clearRole = (roles: RoleSettings, role: RoleKey): RoleSettings => {
	switch (role) {
		case "chat":
			return { ...roles, chat: null }
		case "ask":
			return { ...roles, ask: { enabled: false, pick: null } }
		case "subagents":
			return { ...roles, subagents: { kind: "thread", level: "inherit" } }
		case "background":
			return { ...roles, background: { ...roles.background, pick: null } }
		default: {
			const { [role]: _removed, ...overrides } = roles.background.overrides
			return { ...roles, background: { ...roles.background, overrides } }
		}
	}
}

/** Roles that would be left on a level this model no longer offers. */
export const rolesUsingLevel = (roles: RoleSettings, modelId: string, levelId: string) =>
	(Object.keys(ROLE_LABELS) as RoleKey[]).filter((role) => {
		const pick = rolePick(roles, role)
		return pick?.modelId === modelId && pick.levelId === levelId
	})

/** Where these models are picked, in words, for the confirmation that clears them. */
export const usedBy = (settings: ModelSettings, ids: readonly string[]): string[] => {
	const roles = (Object.keys(ROLE_LABELS) as RoleKey[]).filter((role) => {
		const pick = rolePick(settings.roles, role)
		return !!pick && ids.includes(pick.modelId)
	})
	const listed = settings.subagents.allowed.some((entry) => entry.kind === "model" && ids.includes(entry.modelId))
	return [...roles.map((role) => ROLE_LABELS[role]), ...(listed ? ["the subagents' list"] : [])]
}

/** Fields that open the form's More fold. A fix link to one of these has to open it too. */
export const MORE_FIELD_KEYS: (keyof ModelValues)[] = [
	"temperature",
	"streaming",
	"promptCache",
	"cacheReadPrice",
	"cacheWritePrice",
	"files",
	"tools",
	"images",
	"verbosity",
	"apiFormat",
	"maxInputTokens",
	"thinkingBudgetTokens",
	"extraBody",
]
/** What a model's form shows without opening More. Anything else a fix link names is under More. */
const FRONT_FIELDS = new Set([
	"upstreamId",
	"name",
	"reasoning",
	"levels",
	"inputPrice",
	"outputPrice",
	"contextWindow",
	"maxOutputTokens",
])
export const isMoreField = (field: string | undefined) => !!field && !FRONT_FIELDS.has(field)

export const fieldAnchor = (modelId: string, field: string) => settingsModelElementId(modelId, field)
export const fieldControl = (modelId: string, field: string) => `${settingsModelElementId(modelId, field)}-control`

export const friendlyError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	if (/during this request/i.test(message)) {
		return "Settings changed while this was running, so it stopped. Try again."
	}
	if (/expected revision|revision mismatch|settings changed/i.test(message)) {
		return "Settings kept changing while this saved, so nothing was saved. Try again."
	}
	if (/Invalid saved level/.test(message)) {
		return "Something still points at a level this would remove. Pick another level for it first."
	}
	if (/Reasoning is unknown or unsupported/.test(message)) {
		return "This model isn't marked as able to reason, so a level can't be picked. Set Reasoning to Yes on the model first."
	}
	if (/rollout is disabled/i.test(message)) {
		return "The new settings store isn't turned on in this build, so nothing was saved."
	}
	return validationReason(message) ?? message
}

/** A schema failure arrives as its issues in JSON. Issues name fields and rules, never the rejected value. */
const validationReason = (message: string) => {
	if (!/^\s*[[{]/.test(message)) {
		return undefined
	}
	try {
		const parsed = JSON.parse(message)
		const issues: Array<{ path?: unknown[]; message?: string }> = Array.isArray(parsed) ? parsed : []
		const reasons = issues.slice(0, 3).map(({ path, message: why }) => [path?.join("."), why].filter(Boolean).join(": "))
		return reasons.length ? `The host refused this: ${reasons.join("; ")}` : "The host refused this value."
	} catch {
		return "The host refused this value."
	}
}
