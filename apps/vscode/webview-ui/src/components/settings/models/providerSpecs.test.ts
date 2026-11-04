import type { ProviderListing } from "@shared/proto/cline/models"
import { describe, expect, it, vi } from "vitest"
import { getGenericProviderSettings } from "../providers/providerSettingsRegistry"
import formFields from "./providerFormFields.json"
import { type ProviderSpec, providerSpec } from "./providerSpecs"

vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: {}, StateServiceClient: {} }))

/**
 * Every setting the old provider forms touched, frozen from them before they were deleted (Phase 8).
 * The table must keep a home for each. Nothing here is a model fact, and a new field goes in the spec, not here.
 */
const FORM_FIELDS: Record<string, string[]> = formFields

/** Reasoning, picks and token facts live on the model form, never in a provider's table. */
const MODEL_FORM =
	/^(plan|act)Mode(\w*ModelId|\w*ModelInfo|ReasoningEffort|ThinkingBudgetTokens)$|^(plan|act)Selection$|^contextWindow$/
/** Asked on any connection: Models › its More. */
const CONNECTION_FIELDS = new Set(["requestTimeoutMs"])
/** The spec's "provider controls that do nothing": no control on the new pages, saved values stay in the data. */
const LEFT_OUT = [
	"openRouterProviderSorting",
	"aihubmixAppCode",
	"fireworksModelMaxCompletionTokens",
	"fireworksModelMaxTokens",
	"lmStudioMaxTokens",
	"liteLlmUsePromptCache",
]
/** The old form's name for a setting and the spec's, where they differ. `base-url` means the connection's own URL slot. */
const SAME_FIELD: Record<string, string> = {
	"aws.authentication": "awsAuthentication",
	"aws.profile": "awsProfile",
	"aws.endpoint": "awsBedrockEndpoint",
	"aws.useCrossRegionInference": "awsUseCrossRegionInference",
	"aws.useGlobalInference": "awsUseGlobalInference",
	"aws.usePromptCache": "awsBedrockUsePromptCache",
	"aws.customModelBaseId": "actModeAwsBedrockCustomModelBaseId",
	"aws.accessKeyLength": "awsAccessKey",
	"aws.secretKeyLength": "awsSecretKey",
	"aws.sessionTokenLength": "awsSessionToken",
	"gcp.projectId": "vertexProjectId",
	"gcp.region": "vertexRegion",
	asksageApiUrl: "tasksageApiUrl",
	actModeSapAiCoreDeploymentId: "actModeSapAiCoreDeploymentId",
	planModeSapAiCoreDeploymentId: "actModeSapAiCoreDeploymentId",
	actModeVsCodeLmModelSelector: "actModeVsCodeLmModelSelector",
	planModeVsCodeLmModelSelector: "actModeVsCodeLmModelSelector",
	ollamaBaseUrl: "base-url",
	lmStudioBaseUrl: "base-url",
}
/** What the OpenAI-compatible form sets. It has its own form on the new page, not a spec. */
const COMPATIBLE_FORM = new Set([
	"azureApiVersion",
	"azureIdentity",
	"baseUrl",
	"headers",
	"openAiApiKey",
	"openAiCompatibleApiType",
])

const specIds = (spec: ProviderSpec) => [...spec.fields, ...(spec.modelFields ?? [])].map((field) => field.id)
const hasKey = (spec: ProviderSpec) => spec.auth === "keychain" || spec.auth === "optional-key"
const hasUrl = (spec: ProviderSpec) => spec.fields.some((field) => field.slot === "base-url" || /url$/i.test(field.id))

/** Where a form's setting lives on the new page, or undefined when it has no home: that's the failure. */
const homeOf = (field: string, provider: string): string | undefined => {
	if (provider === "openai-compatible" && COMPATIBLE_FORM.has(field)) {
		return "connection form"
	}
	if (LEFT_OUT.includes(field)) {
		return "left out"
	}
	const spec = providerSpec(provider)
	const named = SAME_FIELD[field] ?? field
	if (named === "base-url" ? spec.fields.some((candidate) => candidate.slot === "base-url") : specIds(spec).includes(named)) {
		return "spec"
	}
	if (MODEL_FORM.test(field)) {
		return "model form"
	}
	if (CONNECTION_FIELDS.has(field)) {
		return "connection"
	}
	if ((/ApiKey$/.test(field) || field === "apiKeyLength") && (hasKey(spec) || specIds(spec).includes("awsBedrockApiKey"))) {
		return "API key"
	}
	if (field === "baseUrl" && hasUrl(spec)) {
		return "spec"
	}
	if (field === "region" && specIds(spec).some((id) => /Region$/.test(id))) {
		return "spec"
	}
	if (field === "apiLine" && specIds(spec).some((id) => /ApiLine$/.test(id))) {
		return "spec"
	}
	return undefined
}

describe("the provider field table against what the old forms set", () => {
	it.each(Object.entries(FORM_FIELDS))("%s: every field has a home on the new page", (provider, fields) => {
		expect(fields.filter((field) => !homeOf(field, provider))).toEqual([])
	})

	it("still has every provider the old forms covered", () => {
		expect(Object.keys(FORM_FIELDS)).toHaveLength(30)
		expect(Object.values(FORM_FIELDS).flat().length).toBeGreaterThan(100)
	})

	it("really fails on a field nothing handles", () => {
		expect(homeOf("madeUpNewSetting", "anthropic")).toBeUndefined()
		expect(homeOf("anthropicApiKey", "cline")).toBeUndefined()
	})

	it("a generic provider's base URL field stays", () => {
		const listing = (id: string) =>
			({ id, name: id, protocol: "openai-chat", allowsCustomModelIds: false }) as ProviderListing
		for (const id of ["gemini", "minimax", "together"]) {
			expect(getGenericProviderSettings(id, listing(id))?.baseUrlField, id).toBeDefined()
			expect(hasUrl(providerSpec(id, listing(id))), id).toBe(true)
		}
	})

	it("offers none of the controls the spec leaves out", () => {
		for (const provider of Object.keys(FORM_FIELDS)) {
			for (const field of LEFT_OUT) {
				expect(specIds(providerSpec(provider))).not.toContain(field)
			}
		}
	})
})
