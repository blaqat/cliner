import { useExtensionState } from "@/context/ExtensionStateContext"
import ViewHeader from "../common/ViewHeader"
import { MigrationFailedNotice, MigrationPending } from "./about/MigrationNotices"
import type { SettingsNavigationRequest } from "./settingsTargets"
import { SettingsShell } from "./shell/SettingsShell"

type SettingsViewProps = {
	onDone: () => void
	navigationRequest?: SettingsNavigationRequest
}

/** The pages need the new settings store. Until the move has made one, this says why and how to get past it. */
const SettingsView = (props: SettingsViewProps) => {
	const { environment, modelSettings, modelSettingsMigrationStatus } = useExtensionState()
	if (modelSettings) {
		return <SettingsShell {...props} />
	}
	return (
		<div className="fixed inset-0 flex flex-col overflow-y-auto">
			<ViewHeader environment={environment} onDone={props.onDone} title="Settings" />
			<div className="max-w-lg px-5 pb-5">
				{modelSettingsMigrationStatus?.status === "failed" ? (
					<MigrationFailedNotice status={modelSettingsMigrationStatus} />
				) : (
					<MigrationPending />
				)}
			</div>
		</div>
	)
}

export default SettingsView
