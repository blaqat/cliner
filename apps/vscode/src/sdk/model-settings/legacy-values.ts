import { type ModelValues, ModelValuesSchema } from "@shared/model-settings"

/** Convert only stored fields. Unknown limits and prices remain unknown. */
export function legacyModelValues(options: Record<string, unknown>, mode: "plan" | "act"): Partial<ModelValues> {
	const prefix = `${mode}Mode`
	const info = Object.entries(options).find(
		([k, v]) => k.startsWith(prefix) && k.endsWith("ModelInfo") && v && typeof v === "object",
	)?.[1] as Record<string, unknown> | undefined
	const values: Record<string, unknown> = {}
	const mappings = {
		contextWindow: "contextWindow",
		maxTokens: "maxOutputTokens",
		inputPrice: "inputPrice",
		outputPrice: "outputPrice",
		cacheReadsPrice: "cacheReadPrice",
		cacheWritesPrice: "cacheWritePrice",
		temperature: "temperature",
	}
	for (const [old, key] of Object.entries(mappings)) if (info && Object.hasOwn(info, old)) values[key] = info[old]
	for (const [old, key] of Object.entries({
		supportsImages: "images",
		supportsPromptCache: "promptCache",
		supportsReasoning: "reasoning",
	}))
		if (typeof info?.[old] === "boolean") values[key] = info[old] ? "yes" : "no"
	const budget = options[`${prefix}ThinkingBudgetTokens`]
	if (typeof budget === "number" && budget > 0) values.thinkingBudgetTokens = budget
	const max = options[`${prefix}OpenAiModelInfo`]
	if (max && typeof max === "object" && Object.hasOwn(max, "maxTokens"))
		values.maxOutputTokens = (max as Record<string, unknown>).maxTokens
	return ModelValuesSchema.partial().parse(values)
}
