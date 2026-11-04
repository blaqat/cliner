import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { RELEASE_NOTES } from "../sections/about/releaseNotes"
import { RemoteConfigSection } from "../sections/RemoteConfigSection"
import { AdvancedFold } from "../shell/AdvancedFold"
import { SettingBlock } from "../shell/SettingRow"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { findRow, isRowVisible } from "../shell/settingsRegistry"

const noHeader = () => null
export const AboutPage = () => {
	const { version, extensionVariant, modelSettings, navigateToAccount } = useExtensionState()
	const [migration, setMigration] = useState(modelSettings?.migration)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
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
	const retry = async () => {
		setBusy(true)
		setError("")
		try {
			const r = await ModelsServiceClient.retryModelSettingsMigration({ json: "{}" })
			setMigration(JSON.parse(r.json))
		} catch {
			setError("Migration could not finish. Your previous setup is preserved. Retry when ready.")
		} finally {
			setBusy(false)
		}
	}
	const { rows, ctx } = useSettingsShell()
	const remoteRow = findRow(rows, "about.remote-config")
	const canSeeRemoteConfig = !!remoteRow && isRowVisible(rows, remoteRow, ctx)
	return (
		<SettingBlock rowId="about.info">
			{migration?.status === "complete" && (
				<p className="text-[11px] text-description">Profiles moved to Models. Your models and levels were kept.</p>
			)}
			{migration?.status === "failed" && (
				<div role="status" className="rounded border border-warning p-2 text-[11px]">
					Models could not be moved. Your previous setup is preserved.{" "}
					{migration.retryable && (
						<Button disabled={busy} size="sm" variant="secondary" onClick={() => void retry()}>
							{busy ? "Retrying…" : "Retry migration"}
						</Button>
					)}
				</div>
			)}
			{migration?.status === "pending" && <p role="status">Moving your model setup…</p>}
			{error && (
				<p role="alert" className="text-error text-[11px]">
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
			<h3 className="mt-3 mb-1 text-[13px]">Cline {version}</h3>
			<p className="text-[11px] text-description">{extensionVariant ?? "VS Code"}</p>
			<h3 className="mt-3 mb-1 text-[12px]">What's new</h3>
			<ul className="pl-4 text-[11px] text-description space-y-2">
				{RELEASE_NOTES[0]?.notes.map((note) => (
					<li key={note}>{note}</li>
				))}
			</ul>
			<Button size="sm" variant="secondary" onClick={navigateToAccount}>
				Cline account
			</Button>
			<p className="text-[11px]">
				<a className="text-link" href="https://docs.cline.bot">
					Documentation
				</a>{" "}
				·{" "}
				<a className="text-link" href="https://github.com/cline/cline/issues">
					Report an issue
				</a>
			</p>
		</SettingBlock>
	)
}
