import { describe, expect, it } from "vitest";
import type { GatewayProviderContext } from "@cline/shared";
import {
	applyCompatibleRequestIntent,
	applyNativeRequestIntent,
	type ModelRequestIntent,
} from "./request-intent";
import { composeAiSdkProviderOptions } from "./provider-options";
const base: ModelRequestIntent = {
	level: { kind: "default" },
	temperature: null,
	verbosity: null,
	maxOutputTokens: null,
	thinkingBudgetTokens: null,
	systemRole: "system",
	extraBody: {},
};
describe("isolated request intent", () => {
	it.each([
		"chat",
		"responses",
	] as const)("omits default reasoning on %s", (format) => {
		expect(
			applyCompatibleRequestIntent(
				{ reasoning_effort: "high", reasoning: { effort: "high" } },
				format,
				base,
			),
		).toEqual({});
	});
	it("preserves gateway effort names and chat token rewriting", () => {
		expect(
			applyCompatibleRequestIntent(
				{ model: "gpt-5", messages: [{ role: "system", content: "hi" }] },
				"chat",
				{
					...base,
					level: { kind: "effort", value: "custom" },
					maxOutputTokens: 400,
					systemRole: "developer",
					extraBody: { seed: 4 },
				},
			),
		).toEqual({
			model: "gpt-5",
			messages: [{ role: "developer", content: "hi" }],
			reasoning_effort: "custom",
			max_completion_tokens: 400,
			seed: 4,
		});
	});
	it("maps Responses controls", () => {
		expect(
			applyCompatibleRequestIntent({}, "responses", {
				...base,
				level: { kind: "effort", value: "xhigh" },
				maxOutputTokens: 400,
				verbosity: "low",
				temperature: 0,
			}),
		).toEqual({
			reasoning: { effort: "xhigh" },
			max_output_tokens: 400,
			text: { verbosity: "low" },
			temperature: 0,
		});
	});
	it("uses the existing native Anthropic budget codec", () => {
		const context: GatewayProviderContext = {
			provider: {
				id: "anthropic",
				name: "Anthropic",
				defaultModelId: "claude",
				models: [],
			},
			model: {
				id: "claude",
				name: "Claude",
				providerId: "anthropic",
				capabilities: ["reasoning"],
				reasoningOptions: [{ type: "budget_tokens", min: 1024, max: 32000 }],
			},
			config: { providerId: "anthropic" },
		};
		const request = applyNativeRequestIntent(
			{ providerId: "anthropic", modelId: "claude", messages: [] },
			context,
			{
				...base,
				level: { kind: "thinking-budget", tokens: 2048 },
				maxOutputTokens: 4096,
			},
		);
		expect(request.reasoning).toEqual({ budgetTokens: 2048 });
		expect(
			JSON.stringify(composeAiSdkProviderOptions(request, context)),
		).toContain("2048");
		expect(() =>
			applyNativeRequestIntent(request, context, {
				...base,
				level: { kind: "effort", value: "gateway-special" },
			}),
		).toThrow();
	});
	it("rejects collisions and unsupported combinations", () => {
		for (const key of [
			"model",
			"reasoning",
			"authorization",
			"max_tokens",
			"text",
		])
			expect(() =>
				applyCompatibleRequestIntent({}, "chat", {
					...base,
					extraBody: { [key]: "x" },
				}),
			).toThrow();
		expect(() =>
			applyCompatibleRequestIntent({}, "chat", {
				...base,
				thinkingBudgetTokens: 1024,
			}),
		).toThrow();
	});
});

it("uses native Google thinking-level and OpenAI verbosity codecs", () => {
	const context: GatewayProviderContext = {
		provider: {
			id: "google",
			name: "Google",
			defaultModelId: "gemini",
			models: [],
		},
		model: {
			id: "gemini",
			name: "Gemini",
			providerId: "google",
			capabilities: ["reasoning"],
		},
		config: { providerId: "google" },
	};
	const request = applyNativeRequestIntent(
		{ providerId: "google", modelId: "gemini", messages: [] },
		context,
		{
			...base,
			level: { kind: "thinking-level", value: "high" },
			temperature: 0,
		},
	);
	expect(composeAiSdkProviderOptions(request, context)).toMatchObject({
		google: { thinkingConfig: { thinkingLevel: "high" } },
	});
	const openai = {
		...context,
		provider: { ...context.provider, id: "openai-native" },
		model: { ...context.model, providerId: "openai-native" },
	};
	const native = applyNativeRequestIntent(
		{ providerId: "openai-native", modelId: "gpt-5", messages: [] },
		openai,
		{ ...base, verbosity: "low", systemRole: "developer" },
	);
	expect(composeAiSdkProviderOptions(native, openai)).toMatchObject({
		openai: { textVerbosity: "low", systemMessageMode: "developer" },
	});
});
it("uses a supported compatible budget codec without also emitting effort", () => {
	const context: GatewayProviderContext = {
		provider: {
			id: "openai-compatible",
			name: "Gateway",
			defaultModelId: "claude",
			models: [],
			metadata: {
				routing: {
					reasoning: {
						format: "anthropic-thinking",
						routes: [{ matcher: "anthropic-compatible" }],
					},
				},
			},
		},
		model: {
			id: "claude-sonnet-4",
			name: "Claude",
			providerId: "openai-compatible",
			capabilities: ["reasoning"],
			reasoningOptions: [{ type: "budget_tokens", min: 1024, max: 32000 }],
		},
		config: { providerId: "openai-compatible" },
	};
	const result = applyCompatibleRequestIntent(
		{},
		"chat",
		{
			...base,
			level: { kind: "effort", value: "high" },
			thinkingBudgetTokens: 2048,
			maxOutputTokens: 4096,
		},
		context,
	);
	expect(result).toMatchObject({ reasoning: { max_tokens: 2048 } });
	expect(result.reasoning_effort).toBeUndefined();
});
it("rejects explicit temperature that the native adapter would silently drop", () => {
	const context: GatewayProviderContext = {
		provider: {
			id: "openai-native",
			name: "OpenAI",
			defaultModelId: "gpt-5",
			models: [],
		},
		model: {
			id: "gpt-5",
			name: "GPT",
			providerId: "openai-native",
			capabilities: ["reasoning"],
		},
		config: { providerId: "openai-native" },
	};
	expect(() =>
		applyNativeRequestIntent(
			{ providerId: "openai-native", modelId: "gpt-5", messages: [] },
			context,
			{ ...base, temperature: 0.5 },
		),
	).toThrow("Temperature conflicts");
});
