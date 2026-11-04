import {
	BUILTIN_MODEL_VALUES,
	type Connection,
	type ModelLevel,
	type ModelPick,
	type ModelRow,
	type ModelValues,
	resolveModelValues,
	type RoleSettings,
} from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { settingsModelElementId } from "../settingsTargets"

export type Effective = ModelSettingsState["effective"][string]

/** The Connection type's secret field for a compatible key, and the prefix every reference shares. */
export const secretRef = (connectionId: string, field: string) => `settings:v1:connection:${connectionId}:${field}`

export const PLANNING_CONTEXT = "~128K"

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

export const API_LABELS = { chat: "Chat Completions", responses: "Responses" } as const

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
	if (effective?.free.value) {
		return "free"
	}
	const input = effective?.inputPrice.value
	const output = effective?.outputPrice.value
	return input == null || output == null ? "price unknown" : `$${input} / $${output}`
}

export type UnknownKey = "context window" | "max output" | "images" | "tools" | "reasoning" | "prices"

export const unknownsOf = (effective: Effective | undefined): UnknownKey[] => {
	if (!effective) {
		return []
	}
	const missing: (UnknownKey | false)[] = [
		effective.contextWindow.value === null && "context window",
		effective.maxOutputTokens.value === null && "max output",
		effective.images.value === "unknown" && "images",
		effective.tools.value === "unknown" && "tools",
		effective.reasoning.value === "unknown" && "reasoning",
		!effective.free.value && (effective.inputPrice.value === null || effective.outputPrice.value === null) && "prices",
	]
	return missing.filter((entry): entry is UnknownKey => !!entry)
}

export const UNKNOWN_EXPLAINED: Record<UnknownKey, string> = {
	"context window": "Context window: Cline plans with 128K and marks the context ring with ~.",
	"max output": "Max output: Cline sends no limit.",
	images: "Images: you can attach them; if the server refuses, the thread says so.",
	tools: "Tools: Cline tries them; if the server refuses, the thread says so.",
	reasoning: "Reasoning: no level is sent, and the selector says why.",
	prices: "Prices: cost shows “unknown”, never $0.",
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

const BUILTIN = BUILTIN_MODEL_VALUES as Record<string, unknown>

/** A shared default that says something: clearing one leaves its builtin value behind, since a patch can't remove a key. */
export const hasSharedValue = (defaults: Connection["defaults"], key: keyof ModelValues) =>
	Object.hasOwn(defaults, key) && JSON.stringify(defaults[key]) !== JSON.stringify(BUILTIN[key])

/** A model overrides this field on purpose. */
export const hasOverride = (row: ModelRow, key: keyof ModelValues) => Object.hasOwn(row.overrides, key)

/** Changed + Reset: a value of its own where the connection shares one. Reset deletes it, so it follows again. */
export const overridesShared = (row: ModelRow, connection: Connection, key: keyof ModelValues) =>
	hasOverride(row, key) && hasSharedValue(connection.defaults, key)

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

/** Detect fills what's still unknown and nothing else: never what someone set, or what's inherited. */
export const detectedFills = (row: ModelRow, effective: Effective | undefined, metadata: Partial<ModelValues>) => {
	const fills: Partial<ModelValues> = {}
	for (const key of Object.keys(metadata) as (keyof ModelValues)[]) {
		if (metadata[key] === undefined || hasOverride(row, key)) {
			continue
		}
		if (!effective || effective[key].source === "builtin") {
			Object.assign(fills, { [key]: metadata[key] })
		}
	}
	return fills
}

/** The pick used to test or preview a model: its strongest level, so the mapping shows. */
export const testPick = (row: ModelRow, effective: Effective | undefined): ModelPick => {
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

export type DependencyLine =
	| { kind: "role"; role: RoleKey }
	| { kind: "model"; modelId: string }
	| { kind: "allowed"; index: number }
	| { kind: "threads"; ids: string[] }
	| { kind: "other"; path: string }

const ROLE_PATHS: Record<string, RoleKey> = {
	"roles.chat": "chat",
	"roles.ask.pick": "ask",
	"roles.subagents.pick": "subagents",
	"roles.background.pick": "background",
	"roles.background.overrides.titles": "titles",
	"roles.background.overrides.commitMessages": "commitMessages",
	"roles.background.overrides.generate": "generate",
}

/** The host's dependency paths, grouped into what a person can act on. Threads collapse into one line. */
export const readDependencies = (paths: string[]): DependencyLine[] => {
	const lines: DependencyLine[] = []
	const threads = new Set<string>()
	for (const path of paths) {
		if (ROLE_PATHS[path]) {
			lines.push({ kind: "role", role: ROLE_PATHS[path] })
		} else if (path.startsWith("model:")) {
			lines.push({ kind: "model", modelId: path.slice("model:".length) })
		} else if (path.startsWith("subagents.allowed")) {
			lines.push({ kind: "allowed", index: Number(path.split(".")[2]) || 0 })
		} else if (path.startsWith("thread:")) {
			threads.add(path.slice("thread:".length).split(".")[0].split(":")[0])
		} else {
			lines.push({ kind: "other", path })
		}
	}
	return threads.size ? [...lines, { kind: "threads", ids: [...threads] }] : lines
}

/** Fields that open the form's More fold. A fix link to one of these has to open it too. */
const MORE_FIELDS = new Set([
	"maxInputTokens",
	"thinkingBudgetTokens",
	"streaming",
	"promptCache",
	"files",
	"systemRole",
	"apiFormat",
	"cacheReadPrice",
	"cacheWritePrice",
])
export const isMoreField = (field: string | undefined) => !!field && MORE_FIELDS.has(field)

export const fieldAnchor = (modelId: string, field: string) => settingsModelElementId(modelId, field)
export const fieldControl = (modelId: string, field: string) => `${settingsModelElementId(modelId, field)}-control`

export type ConnectionTest =
	| { state: "testing" }
	| { state: "done"; result: "ok" | "catalog" | "auth" | "network" | "no-list"; ms: number; listed: number; models: string[] }
	| { state: "error"; message: string }

export const canRunAfter = (test: ConnectionTest | undefined) =>
	test?.state === "done" && (test.result === "ok" || test.result === "no-list" || test.result === "catalog")

export const friendlyError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	if (/expected revision|revision mismatch|settings changed/i.test(message)) {
		return "Settings changed elsewhere, so nothing was saved. Check the value and try again."
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
	if (/^\s*[[{]/.test(message)) {
		return "The host refused this value."
	}
	return message
}
