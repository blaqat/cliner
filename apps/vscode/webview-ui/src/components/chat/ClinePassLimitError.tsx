import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { moveToAccountModel } from "@/components/settings/models/configuredModelActions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderModels } from "@/hooks/useProviderModels"
import { selectedConfiguredModel } from "./composer/selectedConfiguredModel"

interface ClinePassLimitErrorProps {
	message: string
}

const CLINE_PROVIDER_ID = "cline"

/** The same model on Cline's usage billing, else what Cline starts on. Empty when the catalog knows neither. */
export function usageBilledModel(passModelId: string | undefined, clineModelIds: string[], defaultModelId: string) {
	const slug = passModelId?.replace(/^cline-pass\//, "")
	return clineModelIds.find((id) => id === slug || (slug && id.endsWith(`/${slug}`))) ?? defaultModelId
}

const ClinePassLimitError = ({ message }: ClinePassLimitErrorProps) => {
	const { composerApiSelection, currentTaskItem, mode, modelSettings, navigateToSettings } = useExtensionState()
	const { models: clineModels, defaultModelId } = useProviderModels(CLINE_PROVIDER_ID)
	const [isSwitching, setIsSwitching] = useState(false)
	const [didSwitch, setDidSwitch] = useState(false)
	const [error, setError] = useState<string | undefined>()

	const handleSwitchToUsageBasedBilling = async () => {
		// Nothing can switch until the setup has moved. Settings says why and retries.
		if (!modelSettings) {
			navigateToSettings("models")
			return
		}
		setIsSwitching(true)
		setError(undefined)
		try {
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
		} catch (error) {
			console.error("Failed to switch to Cline usage-based billing:", error)
			setError("Failed to switch provider. Select Cline Usage-Billing in Settings > Models.")
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
