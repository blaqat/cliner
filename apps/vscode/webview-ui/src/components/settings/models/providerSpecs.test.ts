import type { ProviderListing } from "@shared/proto/cline/models"
import { describe, expect, it, vi } from "vitest"
import { getGenericProviderSettings } from "../providers/providerSettingsRegistry"
import { type ProviderSpec, providerSpec } from "./providerSpecs"

vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: {}, StateServiceClient: {} }))

/**
 * Guards the field table until Phase 8 deletes the old forms in settings/providers. Each form is read as
 * text. Every setting it touches has to land somewhere on the new page, and its input count is pinned so a
 * control wired some other way still gets looked at. Pin a new count only after adding what it needs here.
 */
const FORMS: Record<string, { provider: string; controls: number }> = {
	AihubmixProvider: { provider: "aihubmix", controls: 1 },
	AnthropicProvider: { provider: "anthropic", controls: 2 },
	AskSageProvider: { provider: "asksage", controls: 2 },
	BasetenProvider: { provider: "baseten", controls: 1 },
	BedrockProvider: { provider: "bedrock", controls: 15 },
	ClaudeCodeProvider: { provider: "claude-code", controls: 1 },
	ClinePassProvider: { provider: "cline-pass", controls: 0 },
	ClineProvider: { provider: "cline", controls: 0 },
	DifyProvider: { provider: "dify", controls: 2 },
	GroqProvider: { provider: "groq", controls: 1 },
	HicapProvider: { provider: "hicap", controls: 1 },
	HuggingFaceProvider: { provider: "huggingface", controls: 1 },
	LMStudioProvider: { provider: "lmstudio", controls: 4 },
	LiteLlmProvider: { provider: "litellm", controls: 2 },
	MoonshotProvider: { provider: "moonshot", controls: 2 },
	OcaProvider: { provider: "oca", controls: 2 },
	OllamaProvider: { provider: "ollama", controls: 4 },
	OpenAICompatible: { provider: "openai-compatible", controls: 17 },
	OpenAINative: { provider: "openai-native", controls: 1 },
	OpenAiCodexProvider: { provider: "openai-codex", controls: 0 },
	OpenRouterProvider: { provider: "openrouter", controls: 1 },
	QwenCodeProvider: { provider: "qwen-code", controls: 1 },
	QwenProvider: { provider: "qwen", controls: 2 },
	RequestyProvider: { provider: "requesty", controls: 3 },
	SapAiCoreProvider: { provider: "sapaicore", controls: 6 },
	VSCodeLmProvider: { provider: "vscode-lm", controls: 1 },
	VercelAIGatewayProvider: { provider: "vercel-ai-gateway", controls: 1 },
	VertexProvider: { provider: "vertex", controls: 6 },
	XaiProvider: { provider: "xai", controls: 1 },
	ZAiProvider: { provider: "zai", controls: 2 },
}

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
/** The form's name for a setting and the spec's, where they differ. `base-url` means the connection's own URL slot. */
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

const sources = import.meta.glob("../providers/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<
	string,
	string
>
const sourceOf = (form: string) => sources[`../providers/${form}.tsx`]

const FIELD_PATTERNS = [
	/apiConfiguration\??\.(\w+)/g,
	/handleFieldChange\(\s*"(\w+)"/g,
	/(?:plan|act):\s*"(\w+)"/g,
	/(?:^|[^.\w])config\??\.((?:\w+\??\.)?\w+)/gm,
]
const fieldsIn = (source: string) => [
	...new Set(FIELD_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1].replace("?", "")))),
]
const CONTROLS =
	/<(ApiKeyField|BaseUrlField|DebouncedTextField|VSCodeTextField|VSCodeCheckbox|VSCodeDropdown|VSCodeRadioGroup)\b/g

describe("the provider field table against the old forms", () => {
	it("lists every form in settings/providers", () => {
		const onDisk = Object.keys(sources)
			.map((path) => path.replace("../providers/", "").replace(".tsx", ""))
			.filter((name) => !/\.test$|ModelPicker|ModelPickerWithManualEntry|^GenericProviderSettings$/.test(name))
		expect(onDisk.sort()).toEqual(Object.keys(FORMS).sort())
	})

	it.each(Object.entries(FORMS))("%s: every field has a home on the new page", (form, { provider }) => {
		const homeless = fieldsIn(sourceOf(form)).filter((field) => !homeOf(field, provider))
		expect(homeless).toEqual([])
	})

	it.each(Object.entries(FORMS))("%s: its controls haven't changed", (form, { controls }) => {
		expect(sourceOf(form).match(CONTROLS)?.length ?? 0).toBe(controls)
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
		for (const { provider } of Object.values(FORMS)) {
			for (const field of LEFT_OUT) {
				expect(specIds(providerSpec(provider))).not.toContain(field)
			}
		}
	})
})
