import { ProviderConfigResponse, WriteProviderConfigRequest } from "@/shared/proto/cline/models"
import {
	assertLegacyProviderWrite,
	type ProviderCatalogController,
	parseProviderIdRequest,
	toProviderConfigPatch,
	toRedactedProviderConfigResponse,
} from "./providerCatalogShared"

export async function writeProviderConfig(
	controller: ProviderCatalogController,
	request: WriteProviderConfigRequest,
): Promise<ProviderConfigResponse> {
	assertLegacyProviderWrite(controller, "Writing a provider configuration")
	const providerId = parseProviderIdRequest(request.providerId)
	const store = controller.getProviderConfigStore()
	const updated = store.write(providerId, toProviderConfigPatch(request.patch))
	return toRedactedProviderConfigResponse(updated, store)
}
