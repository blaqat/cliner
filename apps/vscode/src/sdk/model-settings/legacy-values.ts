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
	return ModelValuesSchema.partial().parse(values)
}

/** Read-only models.json overlay, scoped by canonical provider and upstream model. */
export function sdkModelValues(info: Record<string, unknown>): Partial<ModelValues> {
	const values: Record<string, unknown> = { ...legacyModelValues({ actModeModelInfo: info }, "act") }
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
			.flatMap((option) => (option.type === "effort" ? option.values : []))
			.filter((v: unknown) => typeof v === "string" && v !== "default" && v !== "none") as string[]
		if (efforts.length)
			values.levels = [
				{ id: "default", label: "Default", rank: 0, request: { kind: "default" } },
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
	return ModelValuesSchema.partial().parse(values)
}
