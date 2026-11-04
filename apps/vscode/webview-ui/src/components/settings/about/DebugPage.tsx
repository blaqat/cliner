import { ResetStateRequest } from "@shared/proto/cline/state"
import { StateServiceClient } from "@/services/grpc-client"
import DebugSection from "../sections/DebugSection"
import { SettingBlock } from "../shell/SettingRow"

const noHeader = () => null

export const DebugPage = () => (
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
