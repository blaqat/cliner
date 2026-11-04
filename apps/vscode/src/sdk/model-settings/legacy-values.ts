import { type ModelLevel, type ModelValues, ModelValuesSchema } from "@shared/model-settings"
import { OPENAI_REASONING_EFFORT_OPTIONS } from "@shared/storage/types"

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]
const STANDARD_EFFORTS = OPENAI_REASONING_EFFORT_OPTIONS.filter((effort) => effort !== "none") as string[]
const DEFAULT_LEVEL: ModelLevel = { id: "default", label: "Default", rank: 0, request: { kind: "default" } }

/** Keep each valid field. One bad value costs that value, never the whole model. */
function validModelValues(values: Record<string, unknown>, onInvalid?: (field: string) => void): Partial<ModelValues> {
	const fields = ModelValuesSchema.shape as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>
	const valid: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) continue
		if (fields[key].safeParse(value).success) valid[key] = value
		else onInvalid?.(key)
	}
	return valid as Partial<ModelValues>
}

/** Convert only stored fields. Unknown limits and prices remain unknown. */
export function legacyModelValues(
	options: Record<string, unknown>,
	mode: "plan" | "act",
	onInvalid?: (field: string) => void,
): Partial<ModelValues> {
	const prefix = `${mode}Mode`
	const info = Object.entries(options).find(
		([k, v]) => k.startsWith(prefix) && k.endsWith("ModelInfo") && v && typeof v === "object",
	)?.[1] as Record<string, unknown> | undefined
	const values: Record<string, unknown> = {}
	if (info?.systemRole === "developer" || info?.systemRole === "system") values.systemRole = info.systemRole
	const mappings = {
		contextWindow: "contextWindow",
		maxTokens: "maxOutputTokens",
		maxInputTokens: "maxInputTokens",
		inputPrice: "inputPrice",
		outputPrice: "outputPrice",
		cacheReadsPrice: "cacheReadPrice",
		cacheWritesPrice: "cacheWritePrice",
		temperature: "temperature",
	}
	for (const [old, key] of Object.entries(mappings))
		if (info && Object.hasOwn(info, old) && info[old] !== -1) values[key] = info[old]
	for (const [old, key] of Object.entries({
		supportsImages: "images",
		supportsPromptCache: "promptCache",
		supportsReasoning: "reasoning",
		supportsTools: "tools",
		supportsStreaming: "streaming",
	}))
		if (typeof info?.[old] === "boolean") values[key] = info[old] ? "yes" : "no"
	const verbosity = options[`${prefix}Verbosity`]
	if (["low", "medium", "high"].includes(String(verbosity))) values.verbosity = verbosity
	const budget = options[`${prefix}ThinkingBudgetTokens`]
	if (typeof budget === "number" && budget > 0) values.thinkingBudgetTokens = budget
	const max = options[`${prefix}OpenAiModelInfo`]
	if (max && typeof max === "object" && Object.hasOwn(max, "maxTokens") && (max as Record<string, unknown>).maxTokens !== -1)
		values.maxOutputTokens = (max as Record<string, unknown>).maxTokens
	return validModelValues(values, onInvalid)
}

/** Read-only models.json overlay, scoped by canonical provider and upstream model. */
export function sdkModelValues(info: Record<string, unknown>, onInvalid?: (field: string) => void): Partial<ModelValues> {
	const values: Record<string, unknown> = { ...legacyModelValues({ actModeModelInfo: info }, "act", onInvalid) }
	if (info.maxInputTokens !== undefined) values.maxInputTokens = info.maxInputTokens
	if (Array.isArray(info.capabilities))
		for (const [cap, key] of Object.entries({
			images: "images",
			tools: "tools",
			reasoning: "reasoning",
			streaming: "streaming",
			"prompt-cache": "promptCache",
			files: "files",
		}))
			if (info.capabilities.includes(cap)) values[key] = "yes"
	// models.json capability arrays are partial overlays. The SDK registry keeps
	// tool calling available for custom language models with such arrays.
	if (
		Array.isArray(info.capabilities) &&
		info.capabilities.length &&
		(info.operation === undefined || info.operation === "language")
	)
		values.tools = "yes"
	for (const [old, key] of Object.entries({
		supportsVision: "images",
		supportsAttachments: "files",
		supportsReasoning: "reasoning",
		supportsTools: "tools",
		supportsStreaming: "streaming",
	}))
		if (typeof info[old] === "boolean") values[key] = info[old] ? "yes" : "no"

	const pricing = info.pricing as Record<string, unknown> | undefined
	for (const [old, key] of Object.entries({
		input: "inputPrice",
		output: "outputPrice",
		cacheRead: "cacheReadPrice",
		cacheWrite: "cacheWritePrice",
	}))
		if (values[key] === undefined && pricing?.[old] !== undefined) values[key] = pricing[old]
	if (Array.isArray(info.reasoningOptions)) {
		const efforts = info.reasoningOptions
			.flatMap((option) => (option?.type === "effort" ? option.values : []))
			.filter((v: unknown) => typeof v === "string" && v !== "default" && v !== "none") as string[]
		if (efforts.length)
			values.levels = [
				DEFAULT_LEVEL,
				...[...new Set(efforts)].map((value, i) => ({
					id: value,
					label: value,
					rank: i + 1,
					request: { kind: "effort", value },
				})),
			]
	}
	if (info.apiFormat === "default") values.apiFormat = "chat"
	if (info.apiFormat === "openai-responses") values.apiFormat = "responses"
	return validModelValues(values, onInvalid)
}

const effortRank = (effort: string) => {
	const rank = EFFORT_ORDER.indexOf(effort)
	return rank === -1 ? EFFORT_ORDER.length : rank
}

/**
 * What a migrated model offers: its advertised levels, the standard ladder when nothing is known about it, and
 * only the provider default when it's known not to reason. Saved efforts join the ladder, since an unknown model
 * may well support them; a known list stays as advertised and the pick moves to the closest level instead.
 */
export function migratedLevels(input: {
	advertised?: ModelLevel[]
	withoutReasoning: boolean
	savedEfforts: string[]
	thinkingLevel?: string
}): ModelLevel[] {
	const efforts = [...new Set([...STANDARD_EFFORTS, ...input.savedEfforts])].sort((a, b) => effortRank(a) - effortRank(b))
	const levels: ModelLevel[] = input.withoutReasoning
		? [DEFAULT_LEVEL]
		: input.advertised && input.advertised.length > 1
			? input.advertised
			: [
					DEFAULT_LEVEL,
					...efforts.map(
						(value, i): ModelLevel => ({ id: value, label: value, rank: i + 1, request: { kind: "effort", value } }),
					),
				]
	if (!input.thinkingLevel) return levels
	const thinking = { kind: "thinking-level" as const, value: input.thinkingLevel }
	return levels.some((l) => l.id === input.thinkingLevel)
		? levels.map((l) => (l.id === input.thinkingLevel ? { ...l, request: thinking } : l))
		: [...levels, { id: input.thinkingLevel, label: input.thinkingLevel, rank: levels.length, request: thinking }]
}

/** A saved effort must not stop a migrated thread: use it if offered, else the nearest level below it. */
export function closestOfferedLevel(levels: readonly ModelLevel[], wanted: string): string {
	if (levels.some((l) => l.id === wanted)) return wanted
	const rank = EFFORT_ORDER.indexOf(wanted)
	if (rank === -1) return "default"
	return (
		EFFORT_ORDER.slice(0, rank)
			.reverse()
			.find((effort) => levels.some((l) => l.id === effort)) ?? "default"
	)
}
