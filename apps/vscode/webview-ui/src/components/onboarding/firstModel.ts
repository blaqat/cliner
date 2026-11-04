import type { OpenAiCompatibleModelInfo } from "@shared/api"
import type { Connection, ModelRow, ModelValues } from "@shared/model-settings"
import { buildSaveRequest, getDraftModelInfo, type ProfileDraft } from "../settings/apiProfiles/profileDraft"
import { modelSettingsClient as client, type SecretMutation } from "../settings/models/modelSettingsClient"
import { DEFAULT_OFFERED, newId, newModelRow, STANDARD_LADDER, secretRef } from "../settings/models/modelsView"

export interface FirstModelIds {
	connectionId: string
	modelId: string
}

const CONNECTION_OPTIONS = ["awsRegion", "awsAuthentication", "awsProfile", "awsUseProfile"]
const MODEL_OPTIONS = ["awsUseCrossRegionInference"]

const pickKeys = (options: Record<string, unknown>, keys: string[]) =>
	Object.fromEntries(keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]))

const modelInfoOverrides = (info: OpenAiCompatibleModelInfo | undefined): Partial<ModelValues> => {
	if (!info) return {}
	const overrides: Partial<ModelValues> = {}
	if (info.contextWindow) overrides.contextWindow = info.contextWindow
	if (info.maxTokens && info.maxTokens > 0) overrides.maxOutputTokens = info.maxTokens
	if (typeof info.inputPrice === "number") overrides.inputPrice = info.inputPrice
	if (typeof info.outputPrice === "number") overrides.outputPrice = info.outputPrice
	if (typeof info.temperature === "number") overrides.temperature = info.temperature
	if (typeof info.supportsImages === "boolean") overrides.images = info.supportsImages ? "yes" : "no"
	return overrides
}

/** What the onboarding form says, in the new store's terms. Reuses the old form's cleanup of blanks and headers. */
export function firstModelFromDraft(
	draft: ProfileDraft,
	ids: FirstModelIds,
): { connection: Connection; secrets: SecretMutation[]; model: ModelRow; levelId: string } {
	const request = buildSaveRequest(draft)
	const options = JSON.parse(request.optionsJson || "{}") as Record<string, unknown>
	const { connectionId } = ids
	const shared = { id: connectionId, name: request.name, requestTimeoutMs: null, defaults: {} }
	const typedKey = Object.entries(request.secrets).find(([field]) => !field.startsWith("aws"))?.[1]
	const keyed = { auth: { kind: "keychain" as const, secretRef: secretRef(connectionId, "apiKey") } }
	const levelId = draft.reasoningEffort === "none" ? "default" : draft.reasoningEffort
	const model: ModelRow = {
		...newModelRow(connectionId, draft.modelId.trim(), "", "chat"),
		id: ids.modelId,
		overrides: modelInfoOverrides(getDraftModelInfo(draft)),
		providerOptions: pickKeys(options, MODEL_OPTIONS),
	}
	if (draft.provider === "openai") {
		if (levelId !== "default") {
			model.overrides.reasoning = "yes"
			model.overrides.levels = DEFAULT_OFFERED.some((level) => level.id === levelId) ? DEFAULT_OFFERED : STANDARD_LADDER
		}
		return {
			connection: {
				...shared,
				kind: "openai-compatible",
				baseUrl: String(options.openAiBaseUrl).trim(),
				...(options.azureIdentity === true ? { auth: { kind: "azure-identity" as const } } : keyed),
				headers: Object.entries((options.openAiHeaders as Record<string, string>) ?? {}).map(([name, value]) => ({
					id: newId(),
					name,
					storage: "plain" as const,
					value,
				})),
				apiFormat: draft.openAiCompatibleApiType,
				azureApiVersion: typeof options.azureApiVersion === "string" ? options.azureApiVersion : null,
			},
			secrets: options.azureIdentity === true || !typedKey ? [] : [{ field: "apiKey", operation: "set", value: typedKey }],
			model,
			levelId,
		}
	}
	const fieldSecrets = draft.provider === "bedrock" ? Object.entries(request.secrets) : []
	return {
		connection: {
			...shared,
			kind: "provider",
			providerId: draft.provider,
			baseUrl: typeof options.anthropicBaseUrl === "string" ? options.anthropicBaseUrl.trim() : null,
			...(draft.provider === "bedrock" ? { auth: { kind: "none" as const } } : keyed),
			headers: [],
			options: pickKeys(options, CONNECTION_OPTIONS),
			secretRefs: Object.fromEntries(fieldSecrets.map(([field]) => [field, secretRef(connectionId, field)])),
		},
		secrets:
			draft.provider === "bedrock"
				? fieldSecrets.map(([field, value]) => ({ field, operation: "set" as const, value }))
				: typedKey
					? [{ field: "apiKey", operation: "set", value: typedKey }]
					: [],
		model,
		levelId,
	}
}

/**
 * Onboarding is the person choosing their first model, so it runs Chat and Background text. A failed step
 * can be retried with the same IDs: saves replace what's there.
 */
export async function saveFirstModel(draft: ProfileDraft, ids: FirstModelIds): Promise<void> {
	const { connection, secrets, model, levelId } = firstModelFromDraft(draft, ids)
	let state = await client.get()
	state = await client.saveConnection(state.settings.revision, connection, secrets)
	state = await client.saveModels(state.settings.revision, [model])
	if (!state.effective[model.id]?.levels.value.some((level) => level.id === levelId)) {
		throw new Error(`${model.upstreamId} doesn't offer the ${levelId} level. Choose another reasoning level.`)
	}
	const pick = { modelId: model.id, levelId }
	const { roles } = state.settings
	await client.setRoles(state.settings.revision, {
		...roles,
		chat: pick,
		ask: roles.ask.enabled ? { ...roles.ask, pick } : roles.ask,
		background: { ...roles.background, pick },
	})
}
