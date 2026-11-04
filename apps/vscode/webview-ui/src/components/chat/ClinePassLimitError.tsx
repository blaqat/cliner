import type { ApiConfiguration } from "@shared/api"
import { UpdateApiConfigurationRequest } from "@shared/proto/cline/models"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { moveToAccountModel } from "@/components/settings/models/configuredModelActions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderModels } from "@/hooks/useProviderModels"
import { ModelsServiceClient } from "@/services/grpc-client"
import { selectedConfiguredModel } from "./composer/selectedConfiguredModel"

interface ClinePassLimitErrorProps {
	message: string
}

const CLINE_PROVIDER_ID = "cline"

const getProviderSwitchConfig = (apiConfiguration: ApiConfiguration): ApiConfiguration => {
	return {
		...apiConfiguration,
		planModeApiProvider: CLINE_PROVIDER_ID,
		actModeApiProvider: CLINE_PROVIDER_ID,
	}
}

/** The same model on Cline's usage billing, else what Cline starts on. Empty when the catalog knows neither. */
export function usageBilledModel(passModelId: string | undefined, clineModelIds: string[], defaultModelId: string) {
	const slug = passModelId?.replace(/^cline-pass\//, "")
	return clineModelIds.find((id) => id === slug || (slug && id.endsWith(`/${slug}`))) ?? defaultModelId
}

const ClinePassLimitError = ({ message }: ClinePassLimitErrorProps) => {
	const { apiConfiguration, composerApiSelection, currentTaskItem, mode, modelSettings } = useExtensionState()
	const { models: clineModels, defaultModelId } = useProviderModels(CLINE_PROVIDER_ID)
	const [isSwitching, setIsSwitching] = useState(false)
	const [didSwitch, setDidSwitch] = useState(false)
	const [error, setError] = useState<string | undefined>()

	const handleSwitchToUsageBasedBilling = async () => {
		setIsSwitching(true)
		setError(undefined)
		try {
			if (modelSettings) {
				const current = selectedConfiguredModel({ modelSettings, composerApiSelection }, mode ?? "act")
				const upstreamId = usageBilledModel(current?.model.upstreamId, Object.keys(clineModels ?? {}), defaultModelId)
				if (!upstreamId) {
					setError("Cline's model list isn't available yet. Pick a Cline model in Settings > Models.")
					return
				}
				await moveToAccountModel({
					providerId: CLINE_PROVIDER_ID,
					providerName: "Cline",
					upstreamId,
					modes: ["act", "plan"],
					taskId: currentTaskItem?.id ?? "",
					leaving: current?.model.id,
				})
				setDidSwitch(true)
				return
			}
			const protoConfig = convertApiConfigurationToProto(getProviderSwitchConfig(apiConfiguration ?? {}))
			await ModelsServiceClient.updateApiConfigurationProto(
				UpdateApiConfigurationRequest.create({
					apiConfiguration: protoConfig,
				}),
			)
			setDidSwitch(true)
		} catch (error) {
			console.error("Failed to switch to Cline usage-based billing:", error)
			setError(
				`Failed to switch provider. Select Cline Usage-Billing in ${modelSettings ? "Settings > Models" : "API Configuration settings"}.`,
			)
		} finally {
			setIsSwitching(false)
		}
	}

	return (
		<div
			className="p-2 border-none rounded-md mb-2 bg-(--vscode-textBlockQuote-background)"
			data-testid="cline-pass-limit-error">
			<div className="text-error mb-2">ClinePass limit reached</div>
			<div className="text-(--vscode-descriptionForeground) text-xs wrap-anywhere">{message}</div>
			<div className="text-(--vscode-descriptionForeground) text-xs mt-2">
				Would you like to switch to Usage-Based billing and retry with the Cline provider?
			</div>
			<VSCodeButton
				appearance="primary"
				className="w-full mt-3"
				disabled={isSwitching || didSwitch}
				onClick={handleSwitchToUsageBasedBilling}>
				{isSwitching ? "Switching..." : didSwitch ? "Switched to Usage-Based billing" : "Switch to Usage-Based billing"}
			</VSCodeButton>
			{didSwitch && (
				<div className="text-(--vscode-descriptionForeground) text-xs mt-2">Retry the request after switching.</div>
			)}
			{error && <div className="text-error text-xs mt-2">{error}</div>}
		</div>
	)
}

export default ClinePassLimitError
