import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { FileServiceClient, ModelsServiceClient, UiServiceClient } from "@/services/grpc-client"
import { RELEASE_NOTES, type ReleaseNote } from "../sections/about/releaseNotes"
import { RemoteConfigSection } from "../sections/RemoteConfigSection"
import { AdvancedFold } from "../shell/AdvancedFold"
import { SettingBlock, SettingGroup } from "../shell/SettingRow"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { findRow, isRowVisible } from "../shell/settingsRegistry"
import { MigrationFailedNotice, MigrationIssues } from "./MigrationNotices"

const noHeader = () => null
const ReleaseDropdown = ({ release, defaultOpen }: { release: ReleaseNote; defaultOpen: boolean }) => {
	const [open, setOpen] = useState(defaultOpen)
	return (
		<div data-testid={`about-release-${release.id}`}>
			<button
				aria-expanded={open}
				className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent px-0 py-1 text-left text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
				onClick={() => setOpen((current) => !current)}
				type="button">
				<i
					aria-hidden
					className={cn(
						"codicon shrink-0 text-[12px]! text-description",
						open ? "codicon-chevron-down" : "codicon-chevron-right",
					)}
				/>
				<b className="shrink-0 text-[13px] font-medium">{release.title}</b>
				<span className="min-w-0 truncate text-[12px] text-description">
					{[release.builds, release.date].filter(Boolean).join(" · ")}
				</span>
			</button>
			{open && (
				<ul className="mt-0.5 mb-2 pl-7 text-[12px] leading-[1.45] text-description space-y-1.5">
					{release.notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			)}
		</div>
	)
}

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
				<h3 className="mb-0 text-[13px]">
					Cline {version} <span className="font-normal text-description">· {extensionVariant ?? "VS Code"}</span>
				</h3>
				<div className="mt-2.5 flex flex-wrap gap-2">
					<Button onClick={navigateToAccount} size="sm" variant="secondary">
						Cline account
					</Button>
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
				<p className="mt-2.5 mb-0 text-[12px]">
					<a className="text-link" href="https://docs.cline.bot">
						Documentation
					</a>{" "}
					·{" "}
					<a className="text-link" href="https://github.com/cline/cline/issues">
						Report an issue
					</a>
				</p>
				<h3 className="mt-5 mb-1 text-[13px]">What's new</h3>
				<div className="flex flex-col gap-0.5" data-testid="about-whats-new">
					{RELEASE_NOTES.map((release, index) => (
						<ReleaseDropdown defaultOpen={index === 0} key={release.id} release={release} />
					))}
				</div>
			</SettingBlock>
		</SettingGroup>
	)
}
