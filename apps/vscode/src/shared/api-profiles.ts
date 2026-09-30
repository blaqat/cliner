import type { ApiProvider } from "./api"
import type { OpenaiReasoningEffort } from "./storage/types"

/**
 * Provider allowlist for this fork (plan §1a). Only these providers are
 * selectable in the settings UI; a stored provider outside this list is
 * mapped to the first allowed provider on load.
 */
export const ALLOWED_API_PROVIDERS = ["openai", "bedrock", "anthropic", "openai-native"] as const satisfies readonly ApiProvider[]

export type AllowedApiProvider = (typeof ALLOWED_API_PROVIDERS)[number]

/** Fallback used when a stored provider id is not in the allowlist. */
export const DEFAULT_ALLOWED_API_PROVIDER: ApiProvider = ALLOWED_API_PROVIDERS[0]

export function isAllowedApiProvider(provider: string | undefined): provider is ApiProvider {
	return !!provider && (ALLOWED_API_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * Map a stored provider id to an allowed provider. Anything not in the
 * allowlist (including SDK spellings handled by callers) resolves to the
 * first allowed provider.
 */
export function toAllowedApiProvider(provider: string | undefined): ApiProvider {
	return isAllowedApiProvider(provider) ? provider : DEFAULT_ALLOWED_API_PROVIDER
}

/** OpenAI Compatible "API type" selector value (plan §10). */
export type OpenAiCompatibleApiType = "chat" | "responses"

/**
 * A saved API configuration: one provider + one model plus a snapshot of the
 * non-secret options that describe the provider connection. Secrets are stored
 * separately under `profile:<id>:<secretKey>` in secret storage.
 */
export interface ApiConfigProfile {
	id: string
	name: string
	provider: ApiProvider
	modelId: string
	openAiCompatibleApiType?: OpenAiCompatibleApiType
	/** Applied on assignment; none/unset leaves effort to the provider. */
	reasoningEffort?: OpenaiReasoningEffort
	/** Non-secret option snapshot (subset of ApiConfiguration keys). */
	options?: Record<string, unknown>
}
