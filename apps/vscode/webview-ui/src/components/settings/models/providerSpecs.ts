import type { ProviderListing } from "@shared/proto/cline/models"
import { getFallbackGenericProviderSettings, getGenericProviderSettings } from "../providers/providerSettingsRegistry"

/** Where a provider field's value lives. Option names are the existing typed vocabulary; the host validates them. */
export type FieldSlot = "option" | "base-url" | "secret" | "model-option"

export interface ProviderField {
	id: string
	label: string
	slot: FieldSlot
	type?: "text" | "toggle" | "select" | "selector"
	choices?: readonly { value: string; label: string }[]
	placeholder?: string
	/** Asked for when connecting, and the connection can't work without it. */
	required?: boolean
	hint?: string
	/** The field only makes sense with these other values. */
	shownWhen?: (options: Record<string, unknown>) => boolean
}

export interface ProviderSpec {
	id: string
	/** keychain: one API key. sign-in: an account the SDK owns. fields: its own credentials or none at all. */
	auth: "keychain" | "optional-key" | "sign-in" | "fields"
	note?: string
	fields: ProviderField[]
	/** Settings that belong to one model rather than the connection. */
	modelFields?: ProviderField[]
	signupUrl?: string
}

const API_LINES = [
	{ value: "international", label: "International" },
	{ value: "china", label: "China" },
]
const apiLine = (id: string): ProviderField => ({
	id,
	label: "API line",
	slot: "option",
	type: "select",
	choices: API_LINES,
	required: true,
})
const url = (id: string, label: string, placeholder?: string, required?: boolean): ProviderField => ({
	id,
	label,
	slot: "option",
	placeholder,
	required,
})

const bedrockAuth = (value: string) => (options: Record<string, unknown>) => (options.awsAuthentication ?? "profile") === value

/**
 * Every provider whose setup is more than one API key. Each field here maps one-to-one onto today's
 * provider form. Left out on purpose because nothing reads them: OpenRouter sorting, AIHubMix app code,
 * the Fireworks token overrides, LM Studio max tokens, LiteLLM's cache switch. Saved values stay in the data.
 */
const SPECS: Record<string, Omit<ProviderSpec, "id">> = {
	cline: { auth: "sign-in", note: "Sign in with your Cline account. No key.", fields: [] },
	"cline-pass": { auth: "sign-in", note: "Sign in with your Cline account. No key.", fields: [] },
	"openai-codex": { auth: "sign-in", note: "Sign in with your ChatGPT account.", fields: [] },
	oca: {
		auth: "sign-in",
		note: "Sign in with your Oracle account.",
		fields: [
			url("ocaBaseUrl", "Base URL", "Default"),
			{
				id: "ocaMode",
				label: "Mode",
				slot: "option",
				type: "select",
				choices: [
					{ value: "internal", label: "Internal" },
					{ value: "external", label: "External" },
				],
			},
			{ id: "ocaUsePromptCache", label: "Prompt caching", slot: "option", type: "toggle" },
		],
	},
	anthropic: { auth: "keychain", fields: [{ id: "baseUrl", label: "Base URL", slot: "base-url", placeholder: "Default" }] },
	"openai-native": { auth: "keychain", fields: [] },
	openrouter: { auth: "keychain", fields: [] },
	bedrock: {
		auth: "fields",
		fields: [
			{
				id: "awsAuthentication",
				label: "Authentication",
				slot: "option",
				type: "select",
				required: true,
				choices: [
					{ value: "profile", label: "AWS profile" },
					{ value: "credentials", label: "Access keys" },
					{ value: "apikey", label: "API key" },
				],
			},
			{ id: "awsRegion", label: "Region", slot: "option", placeholder: "us-east-1", required: true },
			{ id: "awsProfile", label: "AWS profile", slot: "option", placeholder: "default", shownWhen: bedrockAuth("profile") },
			{ id: "awsAccessKey", label: "Access key", slot: "secret", required: true, shownWhen: bedrockAuth("credentials") },
			{ id: "awsSecretKey", label: "Secret key", slot: "secret", required: true, shownWhen: bedrockAuth("credentials") },
			{ id: "awsSessionToken", label: "Session token", slot: "secret", shownWhen: bedrockAuth("credentials") },
			{ id: "awsBedrockApiKey", label: "API key", slot: "secret", required: true, shownWhen: bedrockAuth("apikey") },
			{ id: "awsBedrockEndpoint", label: "VPC endpoint", slot: "option", placeholder: "Default" },
		],
		modelFields: [
			{ id: "awsUseCrossRegionInference", label: "Cross-region inference", slot: "model-option", type: "toggle" },
			{ id: "awsUseGlobalInference", label: "Global inference", slot: "model-option", type: "toggle" },
			{ id: "awsBedrockUsePromptCache", label: "Prompt caching", slot: "model-option", type: "toggle" },
			{ id: "actModeAwsBedrockCustomSelected", label: "Use a custom model", slot: "model-option", type: "toggle" },
			{
				id: "actModeAwsBedrockCustomModelBaseId",
				label: "Custom model base",
				slot: "model-option",
				hint: "The model your custom one is based on.",
				shownWhen: (options) => options.actModeAwsBedrockCustomSelected === true,
			},
		],
	},
	vertex: {
		auth: "fields",
		fields: [
			{ id: "vertexProjectId", label: "Project", slot: "option", placeholder: "my-project", required: true },
			{ id: "vertexRegion", label: "Region", slot: "option", placeholder: "us-central1", required: true },
		],
	},
	gemini: { auth: "keychain", fields: [url("geminiBaseUrl", "Base URL", "Default")] },
	ollama: {
		auth: "optional-key",
		fields: [{ id: "baseUrl", label: "Base URL", slot: "base-url", placeholder: "http://localhost:11434" }],
		modelFields: [{ id: "ollamaApiOptionsCtxNum", label: "Context size", slot: "model-option", placeholder: "Default" }],
	},
	lmstudio: {
		auth: "optional-key",
		fields: [{ id: "baseUrl", label: "Base URL", slot: "base-url", placeholder: "http://localhost:1234" }],
	},
	litellm: { auth: "keychain", fields: [url("liteLlmBaseUrl", "Base URL", "http://localhost:4000", true)] },
	requesty: { auth: "keychain", fields: [url("requestyBaseUrl", "Base URL", "Default")] },
	dify: { auth: "keychain", fields: [url("difyBaseUrl", "API URL", "https://api.dify.ai/v1", true)] },
	asksage: { auth: "keychain", fields: [url("tasksageApiUrl", "API URL", "Default")] },
	aihubmix: { auth: "keychain", fields: [url("aihubmixBaseUrl", "Base URL", "Default")] },
	sapaicore: {
		auth: "fields",
		fields: [
			{ id: "sapAiCoreClientId", label: "Client ID", slot: "secret", required: true },
			{ id: "sapAiCoreClientSecret", label: "Client secret", slot: "secret", required: true },
			url("sapAiCoreBaseUrl", "Base URL", "https://…", true),
			url("sapAiCoreTokenUrl", "Token URL", "https://…", true),
			{ id: "sapAiResourceGroup", label: "Resource group", slot: "option", placeholder: "default", required: true },
			{ id: "sapAiCoreUseOrchestrationMode", label: "Orchestration mode", slot: "option", type: "toggle" },
		],
		modelFields: [
			{ id: "actModeSapAiCoreDeploymentId", label: "Deployment ID", slot: "model-option", placeholder: "Default" },
		],
	},
	qwen: { auth: "keychain", fields: [apiLine("qwenApiLine")] },
	moonshot: { auth: "keychain", fields: [apiLine("moonshotApiLine")] },
	zai: { auth: "keychain", fields: [apiLine("zaiApiLine")] },
	"zai-coding-plan": { auth: "keychain", fields: [apiLine("zaiApiLine")] },
	minimax: {
		auth: "keychain",
		fields: [
			apiLine("minimaxApiLine"),
			{ id: "baseUrl", label: "Base URL", slot: "base-url", placeholder: "https://api.minimax.io/anthropic" },
		],
	},
	"qwen-code": {
		auth: "fields",
		fields: [{ id: "qwenCodeOauthPath", label: "OAuth path", slot: "option", placeholder: "~/.qwen/oauth_creds.json" }],
	},
	"claude-code": {
		auth: "fields",
		fields: [{ id: "claudeCodePath", label: "CLI path", slot: "option", placeholder: "claude" }],
	},
	"vscode-lm": {
		auth: "fields",
		note: "Uses the models VS Code already offers. Nothing to sign in to.",
		fields: [],
		modelFields: [{ id: "actModeVsCodeLmModelSelector", label: "VS Code model", slot: "model-option", type: "selector" }],
	},
}

/** OpenAI-compatible is the main case and has its own form, so the chooser doesn't list it as a provider. */
const COMPATIBLE_IDS = new Set(["openai", "openai-compatible"])

/** The first few the chooser shows; the rest sit behind "N more" and the filter. */
const FIRST_PROVIDERS = [
	"cline",
	"anthropic",
	"openai-native",
	"openrouter",
	"bedrock",
	"vertex",
	"gemini",
	"ollama",
	"lmstudio",
	"litellm",
]
export const FIRST_PROVIDER_COUNT = FIRST_PROVIDERS.length

export const providerSpec = (id: string, listing?: ProviderListing): ProviderSpec => {
	const spec = SPECS[id]
	if (spec) {
		return { id, signupUrl: getGenericProviderSettings(id, listing)?.signupUrl, ...spec }
	}
	const generic = (listing && getGenericProviderSettings(id, listing)) || getFallbackGenericProviderSettings(id)
	return {
		id,
		auth: "keychain",
		signupUrl: generic?.signupUrl,
		fields: generic?.baseUrlField
			? [
					{
						id: "baseUrl",
						label: generic.baseUrlField.label?.replace(/^Use custom /i, "") || "Base URL",
						slot: "base-url",
						placeholder: generic.baseUrlField.placeholder,
					},
				]
			: [],
	}
}

/** Provider listings for the chooser: every catalog entry the organization allows, the common ones first. */
export const chooserProviders = (listings: ProviderListing[], allowed: readonly string[] | undefined) =>
	listings
		.filter((listing) => !COMPATIBLE_IDS.has(listing.id) && (!allowed?.length || allowed.includes(listing.id)))
		.sort((a, b) => {
			const rank = (id: string) => {
				const index = FIRST_PROVIDERS.indexOf(id)
				return index < 0 ? FIRST_PROVIDERS.length : index
			}
			return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name)
		})

export const isFieldVisible = (field: ProviderField, options: Record<string, unknown>) => field.shownWhen?.(options) ?? true

/** Credentials the chooser has to collect, by mode. */
export const signInCopy = (spec: ProviderSpec) => spec.note ?? "Sign in to use its models."
