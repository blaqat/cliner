import type { ApiConfiguration, ModelInfo } from "@shared/api"
import { filterChatModelMap, resolveChatModelDefault } from "@/sdk/model-catalog/chat-models"
import type {
	EffectiveProviderConfig,
	Mode,
	ModelSelectionOverrides,
	ProviderCatalog,
	ProviderConfigPatch,
	ProviderConfigStore,
	ProviderId,
	ProviderListing,
	ProviderModelsResult,
	ResolvedModelSelection,
} from "@/sdk/model-catalog/contracts"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import {
	AwsProviderConfig,
	CatalogErrorInfo,
	CommittedModelSelection,
	GcpProviderConfig,
	ModelOverrides as ModelOverridesProto,
	OpenRouterModelInfo,
	ProviderListing as ProviderListingProto,
	ProviderModelsResponse,
	WriteProviderConfigPatch,
} from "@/shared/proto/cline/models"
import { fromProtobufModelOverrides, toProtobufModelOverrides } from "@/shared/proto-conversions/models/modelOverrides"
import { toProtobufModelInfo } from "@/shared/proto-conversions/models/typeConversion"
import type { GlobalStateAndSettings } from "@/shared/storage/state-keys"

export interface ProviderCatalogController {
	getProviderConfigStore(): ProviderConfigStore
	getProviderCatalog(): ProviderCatalog
}

export interface ProviderCatalogStateController extends ProviderCatalogController {
	stateManager: {
		setGlobalStateBatch(updates: Partial<GlobalStateAndSettings>): void
		flushPendingState?(): Promise<void>
		getApiConfiguration?(): ApiConfiguration
	}
	handleApiConfigurationChanged?(previous: ApiConfiguration, next: ApiConfiguration): void
	postStateToWebview?(): Promise<void>
}

export function hasProviderCatalogStateController(
	controller: ProviderCatalogController,
): controller is ProviderCatalogStateController {
	const candidate = controller as { stateManager?: { setGlobalStateBatch?: unknown } }
	return typeof candidate.stateManager?.setGlobalStateBatch === "function"
}

/**
 * Resolve a provider's models through the SDK provider catalog and return
 * them as a plain record, throwing on catalog errors. Shared by the
 * per-provider refresh handlers, which are thin RPC adapters over this call.
 */
export async function resolveProviderModelsRecord(
	controller: ProviderCatalogController,
	providerId: string,
	options?: { readonly forceRefresh?: boolean },
): Promise<Record<string, ModelInfo>> {
	const result = await controller.getProviderCatalog().resolveModels(parseProviderId(providerId), options)
	if (!result.ok) {
		throw new Error(result.error.message)
	}
	return Object.fromEntries(result.models)
}

export function parseProviderIdRequest(rawProviderId: string | undefined, fieldName = "provider_id"): ProviderId {
	const providerId = rawProviderId?.trim()
	if (!providerId) {
		throw new Error(`${fieldName} is required`)
	}
	return parseProviderId(providerId)
}

export function parseModeRequest(rawMode: string | undefined): Mode {
	if (rawMode === "plan" || rawMode === "act") {
		return rawMode
	}
	throw new Error('mode must be "plan" or "act"')
}

export function toProviderListingProto(listing: ProviderListing): ProviderListingProto {
	return ProviderListingProto.create({
		id: listing.id,
		name: listing.name,
		defaultModelId: listing.defaultModelId,
		family: listing.family,
		protocol: listing.protocol,
		authDescription: listing.authDescription,
		baseUrlDescription: listing.baseUrlDescription,
		allowsCustomModelIds: listing.allowsCustomModelIds,
		usageCostDisplay: listing.usageCostDisplay,
	})
}

type ProviderModelsError = Extract<ProviderModelsResult, { ok: false }>["error"]

function toCatalogErrorInfo(error: ProviderModelsError): CatalogErrorInfo {
	return CatalogErrorInfo.create({
		kind: error.kind,
		message: error.message,
		code: error.code,
	})
}

function toProtobufModels(models: ReadonlyMap<string, ModelInfo>): Record<string, OpenRouterModelInfo> {
	const result: Record<string, OpenRouterModelInfo> = {}
	for (const [modelId, modelInfo] of models) {
		result[modelId] = toProtobufModelInfo(modelInfo)
	}
	return result
}

function toModelOverridesProto(overrides: ModelSelectionOverrides | undefined): ModelOverridesProto | undefined {
	return overrides ? toProtobufModelOverrides(overrides) : undefined
}

function toCommittedModelSelectionProto(selection: ResolvedModelSelection | undefined): CommittedModelSelection | undefined {
	if (!selection) {
		return undefined
	}
	return CommittedModelSelection.create({
		providerId: selection.providerId,
		modelId: selection.modelId,
		modelInfo: toProtobufModelInfo(selection.modelInfo),
		overrides: toModelOverridesProto(selection.overrides),
	})
}

function toRedactedAwsProviderConfigProto(aws: EffectiveProviderConfig["aws"]): AwsProviderConfig | undefined {
	if (!aws) {
		return undefined
	}
	return AwsProviderConfig.create({
		authentication: aws.authentication,
		profile: aws.profile,
		accessKeyLength: aws.accessKey?.length ?? 0,
		secretKeyLength: aws.secretKey?.length ?? 0,
		sessionTokenLength: aws.sessionToken?.length ?? 0,
		endpoint: aws.endpoint,
		usePromptCache: aws.usePromptCache,
		customModelBaseId: aws.customModelBaseId,
		useCrossRegionInference: aws.useCrossRegionInference,
		useGlobalInference: aws.useGlobalInference,
	})
}

function toGcpProviderConfigPatch(protoPatch: WriteProviderConfigPatch): ProviderConfigPatch["gcp"] {
	if (!protoPatch.gcp) {
		return undefined
	}
	return {
		...(protoPatch.gcp.projectId !== undefined ? { projectId: protoPatch.gcp.projectId } : {}),
		...(protoPatch.gcp.region !== undefined ? { region: protoPatch.gcp.region } : {}),
	}
}

function toRedactedGcpProviderConfigProto(gcp: EffectiveProviderConfig["gcp"]): GcpProviderConfig | undefined {
	if (!gcp) {
		return undefined
	}
	return GcpProviderConfig.create({
		projectId: gcp.projectId,
		region: gcp.region,
	})
}

function toAwsProviderConfigPatch(protoPatch: WriteProviderConfigPatch): ProviderConfigPatch["aws"] {
	if (!protoPatch.aws) {
		return undefined
	}
	return {
		...(protoPatch.aws.accessKey !== undefined ? { accessKey: protoPatch.aws.accessKey } : {}),
		...(protoPatch.aws.secretKey !== undefined ? { secretKey: protoPatch.aws.secretKey } : {}),
		...(protoPatch.aws.sessionToken !== undefined ? { sessionToken: protoPatch.aws.sessionToken } : {}),
		...(protoPatch.aws.authentication !== undefined ? { authentication: protoPatch.aws.authentication } : {}),
		...(protoPatch.aws.profile !== undefined ? { profile: protoPatch.aws.profile } : {}),
		...(protoPatch.aws.usePromptCache !== undefined ? { usePromptCache: protoPatch.aws.usePromptCache } : {}),
		...(protoPatch.aws.endpoint !== undefined ? { endpoint: protoPatch.aws.endpoint } : {}),
		...(protoPatch.aws.customModelBaseId !== undefined ? { customModelBaseId: protoPatch.aws.customModelBaseId } : {}),
		...(protoPatch.aws.useCrossRegionInference !== undefined
			? { useCrossRegionInference: protoPatch.aws.useCrossRegionInference }
			: {}),
		...(protoPatch.aws.useGlobalInference !== undefined ? { useGlobalInference: protoPatch.aws.useGlobalInference } : {}),
	}
}

export function toProviderModelsResponse(
	providerId: ProviderId,
	requestId: string,
	result: ProviderModelsResult,
): ProviderModelsResponse {
	if (!result.ok) {
		return ProviderModelsResponse.create({
			providerId,
			requestId,
			configFingerprint: result.configFingerprint,
			fetchedAt: result.fetchedAt,
			ok: false,
			models: {},
			error: toCatalogErrorInfo(result.error),
		})
	}

	const chatModels = filterChatModelMap(result.models)
	const defaultModelId = resolveChatModelDefault(result.defaultModelId, chatModels)

	return ProviderModelsResponse.create({
		providerId,
		requestId,
		configFingerprint: result.configFingerprint,
		fetchedAt: result.fetchedAt,
		ok: true,
		models: toProtobufModels(chatModels),
		defaultModelId,
		source: result.source,
	})
}

function toSelectionOverrides(overrides: ModelOverridesProto | undefined): ModelSelectionOverrides | undefined {
	return fromProtobufModelOverrides(overrides)
}
