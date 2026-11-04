import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient, ModelsServiceClient, UiServiceClient } from "@/services/grpc-client"
import { RELEASE_NOTES } from "../sections/about/releaseNotes"
import { RemoteConfigSection } from "../sections/RemoteConfigSection"
import { AdvancedFold } from "../shell/AdvancedFold"
import { SettingBlock, SettingGroup } from "../shell/SettingRow"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { findRow, isRowVisible } from "../shell/settingsRegistry"
import { MigrationFailedNotice, MigrationIssues } from "./MigrationNotices"

const noHeader = () => null
export const AboutPage = () => {
	const { version, extensionVariant, modelSettings, navigateToAccount } = useExtensionState()
	const [migration, setMigration] = useState(modelSettings?.migration)
	const [error, setError] = useState("")
	useEffect(() => {
		let live = true
		ModelsServiceClient.getModelSettingsMigrationStatus({ json: "{}" })
			.then((r) => {
				if (live) setMigration(JSON.parse(r.json))
			})
			.catch(() => {
				if (live) setError("Migration status could not be read. Reopen About to retry.")
			})
		return () => {
			live = false
		}
	}, [])
	const { rows, ctx } = useSettingsShell()
	const remoteRow = findRow(rows, "about.remote-config")
	const canSeeRemoteConfig = !!remoteRow && isRowVisible(rows, remoteRow, ctx)
	return (
		<SettingGroup>
			<SettingBlock className="py-3.5" rowId="about.info">
				{migration?.status === "complete" && <MigrationIssues issues={migration.issues} />}
				{migration?.status === "failed" && <MigrationFailedNotice onRetried={setMigration} status={migration} />}
				{migration?.status === "pending" && <p role="status">Moving your model setup…</p>}
				{error && (
					<p className="text-error text-[12px]" role="alert">
						{error}
					</p>
				)}
				{canSeeRemoteConfig && (
					<div className="pb-1">
						<AdvancedFold featureId="about.info" summary="Remote Config">
							<SettingBlock rowId="about.remote-config">
								<RemoteConfigSection renderSectionHeader={noHeader} />
							</SettingBlock>
						</AdvancedFold>
					</div>
				)}
				<div className="flex gap-2 pt-2">
					<Button
						onClick={() =>
							void FileServiceClient.copyToClipboard({
								value: JSON.stringify({ version, extensionVariant, migration: migration?.status }, null, 2),
							}).catch(() => setError("Could not copy diagnostics. Try again."))
						}
						size="sm"
						variant="secondary">
						Copy diagnostics
					</Button>
					<Button
						onClick={() => void UiServiceClient.openLogs({}).catch(() => setError("Could not open logs. Try again."))}
						size="sm"
						variant="secondary">
						Open logs
					</Button>
				</div>
				<h3 className="mt-3 mb-1 text-[13px]">Cline {version}</h3>
				<p className="text-[12px] text-description">{extensionVariant ?? "VS Code"}</p>
				<h3 className="mt-3 mb-1 text-[13px]">What's new</h3>
				<ul className="pl-4 text-[12px] text-description space-y-2">
					{RELEASE_NOTES[0]?.notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
				<Button onClick={navigateToAccount} size="sm" variant="secondary">
					Cline account
				</Button>
				<p className="text-[12px]">
					<a className="text-link" href="https://docs.cline.bot">
						Documentation
					</a>{" "}
					·{" "}
					<a className="text-link" href="https://github.com/cline/cline/issues">
						Report an issue
					</a>
				</p>
			</SettingBlock>
		</SettingGroup>
	)
}
