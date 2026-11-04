import { type ModelValues, ModelValuesSchema } from "@shared/model-settings"

/** Convert only stored fields. Unknown limits and prices remain unknown. */
export function legacyModelValues(options: Record<string, unknown>, mode: "plan" | "act"): Partial<ModelValues> {
	const prefix = `${mode}Mode`
	const info = Object.entries(options).find(
		([k, v]) => k.startsWith(prefix) && k.endsWith("ModelInfo") && v && typeof v === "object",
	)?.[1] as Record<string, unknown> | undefined
	const values: Record<string, unknown> = {}
	if (info?.systemRole === "developer" || info?.systemRole === "system") values.systemRole = info.systemRole
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
	const verbosity = options[`${prefix}Verbosity`]
	if (["low", "medium", "high"].includes(String(verbosity))) values.verbosity = verbosity
	const budget = options[`${prefix}ThinkingBudgetTokens`]
	if (typeof budget === "number" && budget > 0) values.thinkingBudgetTokens = budget
	const max = options[`${prefix}OpenAiModelInfo`]
	if (max && typeof max === "object" && Object.hasOwn(max, "maxTokens"))
		values.maxOutputTokens = (max as Record<string, unknown>).maxTokens
	return ModelValuesSchema.partial().parse(values)
}

/** Read-only models.json overlay, scoped by canonical provider and upstream model. */
export function sdkModelValues(info: Record<string, unknown>): Partial<ModelValues> {
	const values: Record<string, unknown> = { ...legacyModelValues({ actModeModelInfo: info }, "act") }
	if (info.maxInputTokens !== undefined) values.maxInputTokens = info.maxInputTokens
	for (const [old, key] of Object.entries({
		supportsVision: "images",
		supportsAttachments: "files",
		supportsReasoning: "reasoning",
	}))
		if (typeof info[old] === "boolean") values[key] = info[old] ? "yes" : "no"
	if (Array.isArray(info.capabilities))
		for (const [cap, key] of Object.entries({
			images: "images",
			tools: "tools",
			reasoning: "reasoning",
			streaming: "streaming",
			"prompt-cache": "promptCache",
		}))
			if (info.capabilities.includes(cap)) values[key] = "yes"
	if (info.apiFormat === "default") values.apiFormat = "chat"
	if (info.apiFormat === "openai-responses") values.apiFormat = "responses"
	return ModelValuesSchema.partial().parse(values)
}
