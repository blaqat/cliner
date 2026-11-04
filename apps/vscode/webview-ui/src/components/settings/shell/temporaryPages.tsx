import { useExtensionState } from "@/context/ExtensionStateContext"
import { ResetStateRequest } from "@shared/proto/cline/state"
import { StateServiceClient } from "@/services/grpc-client"
import ApiConfigurationSection from "../sections/ApiConfigurationSection"
import DebugSection from "../sections/DebugSection"
import ProfilesSection from "../sections/ProfilesSection"
import { AdvancedFold } from "./AdvancedFold"
import { SettingBlock, SettingRow } from "./SettingRow"

/**
 * What each page holds until Phases 6 and 7 replace it, so every control stays reachable.
 * Sections that map to one page are mounted whole. Features, General, Terminal and Subagents spread
 * across pages or stores, so their controls appear here as registry rows; those old sections stay
 * as they are for the rollout-off Settings.
 */

const noHeader = () => null

const positiveInteger = (text: string) => {
	const value = Number(text.trim())
	return text.trim() !== "" && Number.isInteger(value) && value >= 1 ? value : undefined
}

export const TemporaryModelsPage = () => {
	const { settingsInitialModelTab } = useExtensionState()
	return (
		<>
			<SettingBlock rowId="models.connections">
				<ApiConfigurationSection initialModelTab={settingsInitialModelTab} renderSectionHeader={noHeader} />
			</SettingBlock>
			<SettingRow rowId="models.background">
				<AdvancedFold featureId="models.background" summary="titles, commit messages, Generate">
					<SettingBlock rowId="models.background.generate">
						<ProfilesSection renderSectionHeader={noHeader} />
					</SettingBlock>
				</AdvancedFold>
			</SettingRow>
		</>
	)
}

export const TemporaryDebugPage = () => (
	<SettingBlock rowId="debug.tools">
		<DebugSection
			onResetState={async (resetGlobalState) => {
				try {
					await StateServiceClient.resetState(ResetStateRequest.create({ global: resetGlobalState }))
				} catch (error) {
					console.error("Failed to reset state:", error)
				}
			}}
			renderSectionHeader={noHeader}
		/>
	</SettingBlock>
)
