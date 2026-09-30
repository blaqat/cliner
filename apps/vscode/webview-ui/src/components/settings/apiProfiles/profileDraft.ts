import { type ApiProvider, type OpenAiCompatibleModelInfo, openAiModelInfoSafeDefaults } from "@shared/api"
import { ALLOWED_API_PROVIDERS, type OpenAiCompatibleApiType, toAllowedApiProvider } from "@shared/api-profiles"
import { ApiConfigProfile, SaveApiProfileRequest } from "@shared/proto/cline/models"

export const PROVIDER_LABELS: Record<string, string> = {
	openai: "OpenAI Compatible",
	bedrock: "AWS Bedrock",
	anthropic: "Anthropic",
	"openai-native": "OpenAI",
}

export const API_TYPE_LABELS: Record<OpenAiCompatibleApiType, string> = {
	chat: "Chat Completions",
	responses: "Responses",
}

/** Non-secret option keys the editor owns, per provider. */
export const PROVIDER_OPTION_KEYS: Record<string, readonly string[]> = {
	anthropic: ["anthropicBaseUrl"],
	openai: ["openAiBaseUrl", "openAiHeaders", "azureApiVersion", "azureIdentity", "planModeOpenAiModelInfo"],
	"openai-native": [],
	bedrock: ["awsRegion", "awsAuthentication", "awsProfile", "awsUseProfile", "awsUseCrossRegionInference"],
}

/** Secret field names the editor owns, per provider. */
export const PROVIDER_SECRET_KEYS: Record<string, readonly string[]> = {
	anthropic: ["apiKey"],
	openai: ["openAiApiKey"],
	"openai-native": ["openAiNativeApiKey"],
	bedrock: ["awsAccessKey", "awsSecretKey", "awsSessionToken", "awsBedrockApiKey"],
}

export interface ProfileDraft {
	/** Undefined while the configuration has not been saved yet. */
	id?: string
	name: string
	provider: ApiProvider
	modelId: string
	openAiCompatibleApiType: OpenAiCompatibleApiType
	/** Non-secret options, including keys the editor does not render. */
	options: Record<string, unknown>
	/** Secret values the user typed. Absent/blank means "unchanged". */
	secrets: Record<string, string>
	/** Secret field names already stored for this profile. */
	savedSecretKeys: string[]
	/** Provider the stored profile had; used to decide which options carry over. */
	savedProvider?: ApiProvider
}

export function newProfileDraft(provider: ApiProvider = ALLOWED_API_PROVIDERS[0]): ProfileDraft {
	return {
		name: "",
		provider,
		modelId: "",
		openAiCompatibleApiType: "chat",
		options: {},
		secrets: {},
		savedSecretKeys: [],
	}
}

export function draftFromProto(profile: ApiConfigProfile): ProfileDraft {
	let options: Record<string, unknown> = {}
	try {
		const parsed = profile.optionsJson ? JSON.parse(profile.optionsJson) : {}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			options = parsed
		}
	} catch {
		// Malformed options are treated as empty.
	}
	const provider = toAllowedApiProvider(profile.provider)
	return {
		id: profile.id,
		name: profile.name,
		provider,
		modelId: profile.modelId,
		openAiCompatibleApiType: profile.openAiCompatibleApiType === "responses" ? "responses" : "chat",
		options,
		secrets: {},
		savedSecretKeys: [...profile.secretKeys],
		savedProvider: provider,
	}
}

/**
 * Switching provider resets model and provider-specific options/secrets; a
 * stored profile keeps its saved secrets only when the provider is unchanged.
 */
export function changeDraftProvider(draft: ProfileDraft, provider: ApiProvider): ProfileDraft {
	if (provider === draft.provider) {
		return draft
	}
	return { ...draft, provider, modelId: "", options: {}, secrets: {} }
}

export function setDraftOption(draft: ProfileDraft, key: string, value: unknown): ProfileDraft {
	return { ...draft, options: { ...draft.options, [key]: value } }
}

export function setDraftSecret(draft: ProfileDraft, key: string, value: string): ProfileDraft {
	return { ...draft, secrets: { ...draft.secrets, [key]: value } }
}

export function getDraftHeaders(draft: ProfileDraft): Record<string, string> {
	const headers = draft.options.openAiHeaders
	return headers && typeof headers === "object" && !Array.isArray(headers) ? (headers as Record<string, string>) : {}
}

export function setDraftHeaders(draft: ProfileDraft, headers: Record<string, string>): ProfileDraft {
	return setDraftOption(draft, "openAiHeaders", headers)
}

/**
 * Model info is snapshotted under a mode-prefixed key; assignment rewrites it
 * onto whichever mode uses the profile. The editor reads either prefix and
 * always writes the plan-prefixed key so only one copy is stored.
 */
export function getDraftModelInfo(draft: ProfileDraft): OpenAiCompatibleModelInfo | undefined {
	return (draft.options.planModeOpenAiModelInfo ?? draft.options.actModeOpenAiModelInfo) as
		| OpenAiCompatibleModelInfo
		| undefined
}

export function setDraftModelInfo(draft: ProfileDraft, patch: Partial<OpenAiCompatibleModelInfo>): ProfileDraft {
	const { actModeOpenAiModelInfo: _, ...options } = draft.options
	const current = getDraftModelInfo(draft) ?? openAiModelInfoSafeDefaults
	return { ...draft, options: { ...options, planModeOpenAiModelInfo: { ...current, ...patch } } }
}

export function hasSavedSecret(draft: ProfileDraft, key: string): boolean {
	return draft.provider === draft.savedProvider && draft.savedSecretKeys.includes(key)
}

/**
 * Split a draft into the SaveApiProfileRequest payload: non-secret options go
 * in `optionsJson`, typed secrets in `secrets`. Blank secret fields are
 * omitted so stored values stay unchanged.
 */
export function buildSaveRequest(draft: ProfileDraft): SaveApiProfileRequest {
	const ownedSecrets = PROVIDER_SECRET_KEYS[draft.provider] ?? []
	const options: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(draft.options)) {
		if (value === undefined || value === null || value === "") {
			continue
		}
		options[key] = value
	}
	if (options.openAiHeaders) {
		// Headers without a name would make every request fail.
		options.openAiHeaders = Object.fromEntries(
			Object.entries(options.openAiHeaders as Record<string, string>)
				.map(([name, value]) => [name.trim(), value] as const)
				.filter(([name]) => name),
		)
	}
	const secrets: Record<string, string> = {}
	for (const key of ownedSecrets) {
		const value = draft.secrets[key]
		if (value) {
			secrets[key] = value
		}
	}
	return SaveApiProfileRequest.create({
		id: draft.id ?? "",
		name: draft.name.trim(),
		provider: draft.provider,
		modelId: draft.modelId,
		openAiCompatibleApiType: draft.provider === "openai" ? draft.openAiCompatibleApiType : "",
		optionsJson: JSON.stringify(options),
		secrets,
	})
}

/**
 * Required configuration per provider. Onboarding uses this so a user can
 * never finish on a provider missing the fields its requests need (e.g. a
 * remapped stale provider with no key). Blank secrets typed in the draft or
 * already stored for it both satisfy the requirement.
 */
export function validateProfileDraftConfig(draft: ProfileDraft): string | undefined {
	if (!draft.modelId.trim()) {
		return "Choose a model."
	}
	const secretValue = (key: string) => draft.secrets[key]?.trim() || (hasSavedSecret(draft, key) ? "saved" : "")
	switch (draft.provider) {
		case "openai":
			if (!String(draft.options.openAiBaseUrl ?? "").trim()) {
				return "A base URL is required for OpenAI Compatible."
			}
			if (!secretValue("openAiApiKey") && draft.options.azureIdentity !== true) {
				return "An API key is required for OpenAI Compatible."
			}
			return undefined
		case "anthropic":
			return secretValue("apiKey") ? undefined : "An API key is required for Anthropic."
		case "openai-native":
			return secretValue("openAiNativeApiKey") ? undefined : "An API key is required for OpenAI."
		case "bedrock": {
			const auth = (draft.options.awsAuthentication as string | undefined) ?? "credentials"
			if (auth === "profile") {
				return String(draft.options.awsProfile ?? "").trim() ? undefined : "An AWS profile name is required."
			}
			if (auth === "apikey") {
				return secretValue("awsBedrockApiKey") ? undefined : "A Bedrock API key is required."
			}
			return secretValue("awsAccessKey") && secretValue("awsSecretKey")
				? undefined
				: "AWS access key and secret key are required."
		}
		default:
			return undefined
	}
}

export function duplicateDraft(draft: ProfileDraft): ProfileDraft {
	return {
		...draft,
		id: undefined,
		name: `${draft.name} copy`,
		// Secrets cannot be read back, so a copy starts without stored ones.
		savedSecretKeys: [],
		savedProvider: undefined,
	}
}

export function describeProfile(profile: {
	provider: string
	modelId: string
	openAiCompatibleApiType?: OpenAiCompatibleApiType
}): string {
	const parts = [PROVIDER_LABELS[profile.provider] ?? profile.provider, profile.modelId || "no model"]
	if (profile.provider === "openai") {
		parts.push(API_TYPE_LABELS[profile.openAiCompatibleApiType ?? "chat"])
	}
	return parts.join(" · ")
}
