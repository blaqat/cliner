import {
	getReasoningDefaultOnMetadata,
	providerReasoningRouteMatches,
	supportsOpenAINoneReasoningEffort,
} from "../model-facts";
import {
	buildAnthropicCompatibleReasoningOptions,
	resolveReasoningRoute,
} from "./anthropic-compatible";
import type {
	GatewayProviderContext,
	GatewayStreamRequest,
	ReasoningEffort,
} from "@cline/shared";
import { normalizeReasoningRequest } from "./reasoning-options";
import { withMaxCompletionTokensForReasoningModels } from "../vendors/openai-compatible";

export type LevelRequest =
	| { kind: "default" }
	| { kind: "effort"; value: string }
	| { kind: "thinking-budget"; tokens: number }
	| { kind: "thinking-level"; value: string };
export interface ModelRequestIntent {
	level: LevelRequest;
	temperature: number | null;
	verbosity: "low" | "medium" | "high" | null;
	maxOutputTokens: number | null;
	thinkingBudgetTokens: number | null;
	systemRole: "system" | "developer";
	extraBody: Record<string, unknown>;
}
const canonicalEfforts = new Set([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const reserved = new Set([
	"system",
	"system_instruction",
	"generationconfig",
	"generation_config",
	"inferenceconfig",
	"additionalmodelrequestfields",
	"maxtokens",
	"maxoutputtokens",
	"maxcompletiontokens",
	"reasoningconfig",
	"thinkingconfig",
	"toolconfig",
	"contents",
	"systeminstruction",
	"prompt",
	"modelid",
	"model_id",
	"model",
	"messages",
	"input",
	"instructions",
	"tools",
	"tool_choice",
	"stream",
	"stream_options",
	"max_tokens",
	"max_completion_tokens",
	"max_output_tokens",
	"reasoning",
	"reasoning_effort",
	"thinking",
	"thinking_budget",
	"thinking_config",
	"temperature",
	"verbosity",
	"text",
	"api_key",
	"apikey",
	"authorization",
	"headers",
	"access_token",
	"token",
]);
export function validateModelRequestIntent(intent: ModelRequestIntent): void {
	if (
		Object.keys(intent.extraBody).some(
			(k) =>
				reserved.has(k.toLowerCase()) ||
				/secret|authorization|password|credential|api.?key|access.?token/i.test(
					k,
				),
		)
	)
		throw new Error("Extra body collides with a dedicated request control");
	for (const n of [
		intent.maxOutputTokens,
		intent.thinkingBudgetTokens,
		intent.level.kind === "thinking-budget" ? intent.level.tokens : null,
	])
		if (n !== null && (!Number.isSafeInteger(n) || n <= 0))
			throw new Error("Token limits must be positive integers");
	if (
		intent.temperature !== null &&
		(!Number.isFinite(intent.temperature) || intent.temperature < 0)
	)
		throw new Error("Invalid temperature");
}
/** Native intent uses the existing catalog normalization and codecs. Reject lossy normalization. */
export function applyNativeRequestIntent(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
	intent: ModelRequestIntent,
): GatewayStreamRequest {
	validateModelRequestIntent(intent);
	if (intent.verbosity !== null && request.providerId !== "openai-native")
		throw new Error("Native verbosity requires a supported provider codec");
	if (intent.systemRole !== "system" && request.providerId !== "openai-native")
		throw new Error("Developer role requires an OpenAI transport");

	const level = intent.level;
	if (
		level.kind === "thinking-level" &&
		(!["google", "gemini", "vertex"].includes(request.providerId) ||
			!["minimal", "low", "medium", "high"].includes(level.value))
	)
		throw new Error(
			"Native thinking-level requires a supported provider codec",
		);
	const nativeNone =
		level.kind === "effort" &&
		level.value === "none" &&
		request.providerId === "openai-native" &&
		supportsOpenAINoneReasoningEffort(request.modelId);
	if (
		level.kind === "effort" &&
		!nativeNone &&
		!canonicalEfforts.has(level.value)
	)
		throw new Error("Unsupported native reasoning effort");
	const budget =
		intent.thinkingBudgetTokens ??
		(level.kind === "thinking-budget" ? level.tokens : null);
	const reasoning: GatewayStreamRequest["reasoning"] =
		budget !== null
			? { budgetTokens: budget }
			: level.kind === "effort"
				? nativeNone
					? { enabled: false }
					: { effort: level.value as ReasoningEffort }
				: undefined;
	const next = {
		...request,
		reasoning,
		temperature: intent.temperature ?? undefined,
		maxTokens: intent.maxOutputTokens ?? undefined,
		defaultedMaxTokens: intent.maxOutputTokens === null ? undefined : false,
	};
	if (
		intent.temperature !== null &&
		!nativeNone &&
		((request.providerId === "openai-native" &&
			context.model.capabilities?.includes("reasoning")) ||
			(getReasoningDefaultOnMetadata(context) === true &&
				(request.providerId === "anthropic" ||
					providerReasoningRouteMatches("anthropic-thinking", next, context))))
	)
		throw new Error(
			"Temperature conflicts with this native model's default reasoning",
		);
	if (reasoning || level.kind === "thinking-level") {
		if (!context.model.capabilities?.includes("reasoning"))
			throw new Error("Model does not advertise reasoning");
		const normalized = normalizeReasoningRequest(next, context).reasoning;
		if (
			(reasoning?.effort && normalized?.effort !== reasoning.effort) ||
			(reasoning?.budgetTokens !== undefined &&
				normalized?.budgetTokens !== reasoning.budgetTokens)
		)
			throw new Error("Saved reasoning control is unsupported by this route");
		if (
			intent.temperature !== null &&
			(providerReasoningRouteMatches("anthropic-thinking", next, context) ||
				request.providerId === "anthropic" ||
				(request.providerId === "openai-native" && !nativeNone))
		)
			throw new Error(
				"Explicit temperature with native reasoning needs a supported route",
			);
	}
	return {
		...next,
		metadata: { ...request.metadata, settingsRequestIntent: intent },
	};
}
/** Apply intent to the vendor's final body, shared by execution and preview. */
export function applyCompatibleRequestIntent(
	body: Record<string, unknown>,
	format: "chat" | "responses",
	intent: ModelRequestIntent,
	context?: GatewayProviderContext,
): Record<string, unknown> {
	validateModelRequestIntent(intent);
	let budgetReasoning: Record<string, unknown> | undefined;
	const budget =
		intent.thinkingBudgetTokens ??
		(intent.level.kind === "thinking-budget" ? intent.level.tokens : null);
	if (intent.level.kind === "thinking-level")
		throw new Error(
			"This compatible route does not advertise a thinking-level codec",
		);
	if (budget !== null) {
		if (!context)
			throw new Error(
				"This compatible route does not advertise a budget codec",
			);
		const request: GatewayStreamRequest = {
			providerId: context.provider.id,
			modelId: context.model.id,
			messages: [],
			maxTokens: intent.maxOutputTokens ?? undefined,
			defaultedMaxTokens: intent.maxOutputTokens === null ? undefined : false,
			reasoning: { budgetTokens: budget },
		};
		if (!resolveReasoningRoute(request, context))
			throw new Error(
				"This compatible route does not advertise a budget codec",
			);
		const normalized = normalizeReasoningRequest(request, context);
		if (normalized.reasoning?.budgetTokens !== budget)
			throw new Error("Budget is unsupported by this route");
		budgetReasoning = buildAnthropicCompatibleReasoningOptions(
			normalized,
			context,
		);
		if (!budgetReasoning)
			throw new Error("Budget is unsupported by this route");
	}
	const result = { ...body, ...intent.extraBody };
	delete result.max_tokens;
	delete result.max_completion_tokens;
	delete result.max_output_tokens;
	delete result.temperature;
	delete result.verbosity;
	if (result.text && typeof result.text === "object") {
		const { verbosity: _verbosity, ...text } = result.text as Record<
			string,
			unknown
		>;
		result.text = text;
	}
	delete result.reasoning_effort;
	delete result.reasoning;
	if (budgetReasoning) result.reasoning = budgetReasoning;
	else if (intent.level.kind === "effort") {
		if (format === "chat") result.reasoning_effort = intent.level.value;
		else result.reasoning = { effort: intent.level.value };
	}
	if (intent.temperature !== null) result.temperature = intent.temperature;
	if (intent.maxOutputTokens !== null)
		result[format === "chat" ? "max_tokens" : "max_output_tokens"] =
			intent.maxOutputTokens;
	if (intent.verbosity !== null) {
		if (format === "chat") result.verbosity = intent.verbosity;
		else
			result.text = {
				...((result.text as object) ?? {}),
				verbosity: intent.verbosity,
			};
	}
	for (const field of ["messages", "input"])
		if (Array.isArray(result[field]))
			result[field] = (result[field] as Array<Record<string, unknown>>).map(
				(m) =>
					m.role === "system" || m.role === "developer"
						? { ...m, role: intent.systemRole }
						: m,
			);
	return format === "chat"
		? withMaxCompletionTokensForReasoningModels(result)
		: result;
}

export function buildNativeIntentOptions(
	request: GatewayStreamRequest,
): Record<string, Record<string, unknown>> | undefined {
	const intent = request.metadata?.settingsRequestIntent as
		| ModelRequestIntent
		| undefined;
	if (!intent) return undefined;
	validateModelRequestIntent(intent);
	if (request.providerId === "openai-native")
		return {
			openai: {
				systemMessageMode: intent.systemRole,
				...(intent.verbosity !== null
					? { textVerbosity: intent.verbosity }
					: {}),
			},
		};
	if (
		intent.level.kind === "thinking-level" &&
		intent.thinkingBudgetTokens === null
	) {
		const bucket = request.providerId === "vertex" ? "vertex" : "google";
		return {
			[bucket]: { thinkingConfig: { thinkingLevel: intent.level.value } },
		};
	}
	return undefined;
}
