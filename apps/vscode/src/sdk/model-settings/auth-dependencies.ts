import type { StateManager } from "@/core/storage/StateManager"
import { getProviderSettingsManager } from "../provider-migration"
import type { ConnectionAuthDependencies } from "./request-adapter"

/**
 * Account access is explicit; keychain connections never enter this branch.
 * No azureIdentity token source: the legacy path only records useIdentity and
 * nothing acquires an Entra token, so an identity connection sends no key.
 */
export function modelAuthDependencies(state: Pick<StateManager, "connectionSecrets">): ConnectionAuthDependencies {
	if (!state.connectionSecrets) throw new Error("Connection keychain is unavailable")
	return {
		secrets: state.connectionSecrets,
		environment: process.env,
		sdkAccount: async (providerId) => {
			const config = getProviderSettingsManager().getProviderConfig(providerId)
			if (!config) throw new Error("SDK account is unavailable")
			return {
				providerId: config.providerId,
				apiKey: config.apiKey,
				apiKeyEnv: [],
				baseUrl: config.baseUrl,
				headers: config.headers,
				options: {
					region: config.region,
					project: config.gcp?.projectId,
					location: config.gcp?.region,
					accessKeyId: config.aws?.accessKey,
					secretAccessKey: config.aws?.secretKey,
					sessionToken: config.aws?.sessionToken,
					authentication: config.aws?.authentication,
					profile: config.aws?.profile,
				},
			}
		},
	}
}
