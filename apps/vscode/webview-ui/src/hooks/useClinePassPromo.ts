import { useCallback, useMemo } from "react"
import { selectedConfiguredModel } from "@/components/chat/composer/selectedConfiguredModel"
import { buildClinePassSubscribeUrl, buildClinePassSubscriptionPageUrl } from "@/components/onboarding/clinePassSubscribe"
import { ensureAccountConnection } from "@/components/settings/models/configuredModelActions"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

export const CLINE_PASS_PROVIDER_ID = "cline-pass"

/**
 * Shared state + actions for the ClinePass promotional surfaces (home banner,
 * account page card, settings provider hint). Promotions are hidden in
 * self-hosted mode (ClinePass is a cloud subscription) and behind org
 * remote-config provider allowlists so they never offer a provider the
 * organization disallows.
 */
export function useClinePassPromo() {
	const { composerApiSelection, environment, modelSettings, navigateToSettings, remoteConfigSettings, mode } =
		useExtensionState()
	const { clineUser } = useClineAuth()

	const isSelfHostedOrUnknown = !environment || environment === "selfHosted"
	const remoteProviders: string[] = remoteConfigSettings?.remoteConfiguredProviders || []
	const isBlockedByRemoteConfig = remoteProviders.length > 0 && !remoteProviders.includes(CLINE_PASS_PROVIDER_ID)
	const isClinePassEnabled = !isSelfHostedOrUnknown && !isBlockedByRemoteConfig

	const isUsingClinePass =
		selectedConfiguredModel({ modelSettings, composerApiSelection }, mode)?.provider === CLINE_PASS_PROVIDER_ID

	const subscribeUrl = useMemo(() => buildClinePassSubscribeUrl(clineUser?.appBaseUrl), [clineUser?.appBaseUrl])
	const manageSubscriptionUrl = useMemo(() => buildClinePassSubscriptionPageUrl(clineUser?.appBaseUrl), [clineUser?.appBaseUrl])

	const openSubscribePage = useCallback(() => {
		UiServiceClient.openUrl({ value: subscribeUrl }).catch((err) =>
			console.error("Failed to open ClinePass subscribe page:", err),
		)
	}, [subscribeUrl])

	const openManageSubscriptionPage = useCallback(() => {
		UiServiceClient.openUrl({ value: manageSubscriptionUrl }).catch((err) =>
			console.error("Failed to open ClinePass subscription page:", err),
		)
	}, [manageSubscriptionUrl])

	// Adds the connection and lands on it: models live on that page, so the person picks one there and nothing
	// here changes what runs. Without the store, that page says why it can't open yet.
	const switchToClinePassProvider = useCallback(async () => {
		if (!modelSettings) {
			navigateToSettings("models")
			return
		}
		try {
			navigateToSettings(`connection:${await ensureAccountConnection(CLINE_PASS_PROVIDER_ID, "ClinePass")}`)
		} catch (error) {
			console.error("Failed to add the ClinePass connection:", error)
			navigateToSettings("models")
		}
	}, [modelSettings, navigateToSettings])

	return {
		isClinePassEnabled,
		isUsingClinePass,
		subscribeUrl,
		manageSubscriptionUrl,
		openSubscribePage,
		openManageSubscriptionPage,
		switchToClinePassProvider,
	}
}
