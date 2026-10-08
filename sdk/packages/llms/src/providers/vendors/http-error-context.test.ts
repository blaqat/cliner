import type { GatewayStreamRequest } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { supportsOpenAINoneReasoningEffort } from "../model-facts";
import { resolvePortableReasoning } from "../routing/portable-reasoning";
import {
	resolveAzureResponsesEndpoint,
	withHttpErrorContext,
} from "./http-error-context";

describe("withHttpErrorContext", () => {
	it("appends status and endpoint to JSON error messages", async () => {
		const fetch = withHttpErrorContext(async () =>
			Response.json(
				{ error: { code: "404", message: "Resource not found" } },
				{ status: 404 },
			),
		);
		const response = await fetch(
			"https://x.openai.azure.com/openai/deployments/d/responses?api-version=1",
			{ method: "POST" },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				code: "404",
				message:
					"Resource not found (HTTP 404 from POST https://x.openai.azure.com/openai/deployments/d/responses)",
			},
		});
	});

	it("passes successful responses through untouched", async () => {
		const ok = new Response("data");
		const fetch = withHttpErrorContext(async () => ok);
		expect(await fetch("https://example.test/v1/responses")).toBe(ok);
	});
});

describe("resolveAzureResponsesEndpoint", () => {
	it("maps deployment-style and bare Azure URLs to the v1 base", () => {
		expect(
			resolveAzureResponsesEndpoint(
				"https://x.openai.azure.com/openai/deployments/gpt-5.6-sol/",
			),
		).toEqual({
			baseUrl: "https://x.openai.azure.com/openai/v1",
			deployment: "gpt-5.6-sol",
		});
		expect(
			resolveAzureResponsesEndpoint("https://x.cognitiveservices.azure.com"),
		).toEqual({ baseUrl: "https://x.cognitiveservices.azure.com/openai/v1" });
	});

	it("maps an API Management deployment URL to /openai with the api-version", () => {
		expect(
			resolveAzureResponsesEndpoint(
				"https://x.azure-api.net/openai/deployments/gpt-5.5",
				"2025-04-01-preview",
			),
		).toEqual({
			baseUrl: "https://x.azure-api.net/openai",
			deployment: "gpt-5.5",
			apiVersion: "2025-04-01-preview",
		});
		expect(
			resolveAzureResponsesEndpoint(
				"https://x.azure-api.net/team/openai/deployments/gpt-5.5?api-version=2025-01-01-preview",
			),
		).toMatchObject({
			baseUrl: "https://x.azure-api.net/team/openai",
			apiVersion: "2025-01-01-preview",
		});
	});

	it("leaves v1 Azure URLs and other hosts alone", () => {
		expect(
			resolveAzureResponsesEndpoint("https://x.openai.azure.com/openai/v1"),
		).toBeUndefined();
		expect(
			resolveAzureResponsesEndpoint("https://api.openai.com/v1"),
		).toBeUndefined();
	});
});

describe("explicit none effort for OpenAI Compatible", () => {
	it("recognizes GPT-5.1+ model ids", () => {
		for (const id of ["gpt-5.1", "gpt-5.6-sol", "gpt-6-luna", "gpt-6.1-sol"]) {
			expect(supportsOpenAINoneReasoningEffort(id), id).toBe(true);
		}
		for (const id of ["gpt-5", "gpt-5-mini", "o3", "gpt-4.1", "llama-3"]) {
			expect(supportsOpenAINoneReasoningEffort(id), id).toBe(false);
		}
	});

	it("sends none when reasoning is off for GPT-5.1+ on openai-compatible", () => {
		const request = (modelId: string) =>
			({
				providerId: "openai-compatible",
				modelId,
				messages: [],
				reasoning: { enabled: false },
			}) as unknown as GatewayStreamRequest;
		expect(resolvePortableReasoning(request("gpt-5.6-sol"))).toBe("none");
		expect(resolvePortableReasoning(request("llama-3"))).toBeUndefined();
	});
});
