import { ResetStateRequest } from "@shared/proto/cline/state"
import { StateServiceClient } from "@/services/grpc-client"
import DebugSection from "../sections/DebugSection"
import { SettingBlock } from "./SettingRow"

/**
 * What each page holds until Phases 6 and 7 replace it, so every control stays reachable.
 * Sections that map to one page are mounted whole. Features, General, Terminal and Subagents spread
 * across pages or stores, so their controls appear here as registry rows; those old sections stay
 * as they are for the rollout-off Settings.
 */

const noHeader = () => null

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
