import type { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useMemo, useState } from "react"
import { moveToAccountModel } from "@/components/settings/models/configuredModelActions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderModels } from "@/hooks/useProviderModels"
import { selectedConfiguredModel } from "./composer/selectedConfiguredModel"

interface ClineFreeModelLimitErrorProps {
	message: string
}

const CLINE_PROVIDER_ID = "cline"
const CLINE_FREE_MODEL_PREFIX = "cline-free/"
const FREE_MODEL_LIMIT_RETRY_MARKER = "try again in "

function extractFreeModelLimitResetTime(message: string): string | undefined {
	const backendMessage = message.toLowerCase()
	const resetStart = backendMessage.indexOf(FREE_MODEL_LIMIT_RETRY_MARKER)
	if (resetStart === -1) {
		return undefined
	}

	const resetTime = backendMessage.slice(resetStart + FREE_MODEL_LIMIT_RETRY_MARKER.length).trim()
	return resetTime || undefined
}

// Free model ids are cline-free/<model-slug>; their paid counterpart is the
// catalog model with the same slug under its lab prefix (e.g.
// cline-free/deepseek-v4-flash -> deepseek/deepseek-v4-flash).
function findPaidModelId(freeModelId: string | undefined, clineModelIds: string[]): string | undefined {
	if (!freeModelId?.startsWith(CLINE_FREE_MODEL_PREFIX)) {
		return undefined
	}

	const modelSlug = freeModelId.slice(CLINE_FREE_MODEL_PREFIX.length)
	if (!modelSlug) {
		return undefined
	}

	return clineModelIds.find(
		(modelId) => !modelId.startsWith(CLINE_FREE_MODEL_PREFIX) && (modelId === modelSlug || modelId.endsWith(`/${modelSlug}`)),
	)
}

const ClineFreeModelLimitError = ({ message }: ClineFreeModelLimitErrorProps) => {
	const { composerApiSelection, currentTaskItem, mode, modelSettings } = useExtensionState()
	const { models: clineModels } = useProviderModels(CLINE_PROVIDER_ID)
	const [isSwitching, setIsSwitching] = useState(false)
	const [didSwitch, setDidSwitch] = useState(false)
	const [switchError, setSwitchError] = useState<string | undefined>()

	const resetTime = extractFreeModelLimitResetTime(message)
	const currentMode: Mode = mode ?? "act"
	// Free models are selectable on both the cline and cline-pass providers, so
	// read the model id from whichever provider is currently selected.
	const configured = selectedConfiguredModel({ modelSettings, composerApiSelection }, currentMode)
	const selectedFreeModelId =
		configured?.provider === "cline-pass" || configured?.provider === CLINE_PROVIDER_ID
			? configured.model.upstreamId
			: undefined
	const paidModelId = useMemo(
		() => findPaidModelId(selectedFreeModelId, Object.keys(clineModels ?? {})),
		[selectedFreeModelId, clineModels],
	)

	const handleSwitchToPaidModel = async () => {
		if (!paidModelId) {
			return
		}
		setIsSwitching(true)
		setSwitchError(undefined)
		try {
			await moveToAccountModel({
				providerId: CLINE_PROVIDER_ID,
				providerName: "Cline",
				upstreamId: paidModelId,
				modes: [currentMode],
				taskId: currentTaskItem?.id ?? "",
				leaving: configured?.model.id,
			})
			setDidSwitch(true)
		} catch (error) {
			console.error("Failed to switch to the paid model:", error)
			setSwitchError(`Failed to switch model. Select ${paidModelId} in Settings > Models.`)
		} finally {
			setIsSwitching(false)
		}
	}

	return (
		<div
			className="p-2 border-none rounded-md mb-2 bg-(--vscode-textBlockQuote-background)"
			data-testid="cline-free-model-limit-error">
			<div className="text-error mb-2">Daily free model limit reached</div>
			<div className="text-(--vscode-descriptionForeground) text-xs wrap-anywhere">
				You've reached today's free usage limit for this model.
			</div>
			<div className="text-(--vscode-descriptionForeground) text-xs mt-2">
				{resetTime ? `Try again in ${resetTime}` : "Try again later"} or select another model.
			</div>
			{paidModelId && (
				<>
					<div className="text-(--vscode-descriptionForeground) text-xs mt-2 wrap-anywhere">
						Or switch to the paid version of this model ({paidModelId}) with usage-based billing.
					</div>
					<VSCodeButton
						appearance="primary"
						className="w-full mt-3"
						disabled={isSwitching || didSwitch}
						onClick={handleSwitchToPaidModel}>
						{isSwitching
							? "Switching..."
							: didSwitch
								? "Switched to Usage-Based billing"
								: "Switch to Usage-Based billing"}
					</VSCodeButton>
					{didSwitch && (
						<div className="text-(--vscode-descriptionForeground) text-xs mt-2">
							Retry the request after switching.
						</div>
					)}
					{switchError && <div className="text-error text-xs mt-2">{switchError}</div>}
				</>
			)}
		</div>
	)
}

export default ClineFreeModelLimitError
