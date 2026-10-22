import type { ThreadWorktreeSettings } from "@shared/thread-worktrees"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { FeatureField, FeatureGroup, FeatureRow } from "@/components/settings/sections/FeatureRow"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { threadWorktreeAction, useWorktree } from "./useWorktree"

/** The Worktrees group in Settings → Features: mode, mm paths, the per-workspace switch and cleanup. */
export function WorktreeSettings() {
	const { state, refresh, error } = useWorktree()
	const [draft, setDraft] = useState<ThreadWorktreeSettings>()
	const [selected, setSelected] = useState<string[]>([])
	const [warnings, setWarnings] = useState<Record<string, string>>({})
	const [message, setMessage] = useState<string>()
	const [busy, setBusy] = useState(false)
	const settings = draft ?? state?.settings
	const run = async (action: () => Promise<void>) => {
		setBusy(true)
		try {
			await action()
			await refresh()
		} catch (error) {
			setMessage(String(error))
		} finally {
			setBusy(false)
		}
	}
	if (!state || !settings) return error ? <InlineNotice tone="error">{error}</InlineNotice> : null
	const confirming = Object.keys(warnings).length > 0
	return (
		<FeatureGroup aria-label="Worktrees" id="worktree-features" title="Worktrees">
			<FeatureField
				description="Workspaces with .mmrc use mm automatically. In other workspaces, mm mode uses Git worktrees. New threads start in your workspace."
				htmlFor="worktrees-mode"
				label="Mode">
				<Select
					disabled={busy}
					onValueChange={(mode) => setDraft({ ...settings, mode: mode as ThreadWorktreeSettings["mode"] })}
					value={settings.mode}>
					<SelectTrigger aria-label="Worktrees mode" className="w-full" id="worktrees-mode">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="off">Off</SelectItem>
						<SelectItem value="git">Git worktree</SelectItem>
						<SelectItem value="mm">mm</SelectItem>
					</SelectContent>
				</Select>
			</FeatureField>
			{(settings.mode === "mm" || state.availability.hasMmrc) && (
				<>
					<FeatureField className="pt-0" htmlFor="worktrees-mm-path" label="Path to mm.js">
						<Input
							aria-label="Path to mm.js"
							id="worktrees-mm-path"
							onChange={(e) => setDraft({ ...settings, mmPath: e.target.value })}
							placeholder="/path/to/mm.js"
							value={settings.mmPath}
						/>
					</FeatureField>
					<FeatureField className="pt-0" htmlFor="worktrees-node-path" label="Path to node">
						<Input
							aria-label="Path to node"
							id="worktrees-node-path"
							onChange={(e) => setDraft({ ...settings, nodePath: e.target.value })}
							placeholder="node"
							value={settings.nodePath}
						/>
					</FeatureField>
				</>
			)}
			{draft && (
				<div className="flex justify-end px-1 pb-3">
					<Button
						disabled={busy}
						onClick={() =>
							void run(async () => {
								await threadWorktreeAction("configure", "", draft)
								setDraft(undefined)
							})
						}
						size="sm">
						Save worktree settings
					</Button>
				</div>
			)}
			<FeatureRow
				checked={state.availability.workspaceOff}
				description={
					<>
						New threads in this workspace never start in a worktree.
						{state.availability.reason && <span className="mt-1 block">{state.availability.reason}</span>}
					</>
				}
				disabled={busy}
				id="worktrees-workspace-off"
				label="Off for this workspace"
				onChange={(disabled) =>
					void run(async () => {
						await threadWorktreeAction("workspaceOff", "", { disabled })
					})
				}
			/>
			<div className="space-y-2 py-3 px-1" data-testid="worktrees-settled">
				<div className="text-sm font-medium text-foreground">{state.settled.length} settled worktrees</div>
				{state.settled.length === 0 ? (
					<p className="m-0 text-xs text-description">Worktrees of settled threads show up here for cleanup.</p>
				) : (
					<div className="flex flex-col gap-1">
						{state.settled.map((mapping) => (
							<div key={mapping.threadId}>
								<VSCodeCheckbox
									checked={selected.includes(mapping.threadId)}
									disabled={busy}
									onChange={(event) => {
										const checked = (event.target as HTMLInputElement).checked
										setSelected((current) =>
											checked
												? current.includes(mapping.threadId)
													? current
													: [...current, mapping.threadId]
												: current.filter((id) => id !== mapping.threadId),
										)
									}}>
									<span className="ph-no-capture break-all font-mono text-xs">{mapping.branch}</span>
									<span className="block text-xs text-description">
										{mapping.transferredDiff ? "Brought in / taken over" : "Never brought in"}
									</span>
								</VSCodeCheckbox>
								{warnings[mapping.threadId] && (
									<InlineNotice className="mt-1" tone="warning">
										{warnings[mapping.threadId]}
									</InlineNotice>
								)}
							</div>
						))}
					</div>
				)}
				{selected.length > 0 && (
					<div className="flex justify-end">
						<Button
							disabled={busy}
							onClick={() =>
								void run(async () => {
									const nextWarnings: Record<string, string> = {}
									for (const id of selected) {
										const result = await threadWorktreeAction("remove", id, undefined, !!warnings[id])
										if (result.warning) nextWarnings[id] = result.warning
									}
									setWarnings(nextWarnings)
									setSelected(Object.keys(nextWarnings))
								})
							}
							size="sm"
							variant={confirming ? "danger" : "secondary"}>
							{confirming ? "Confirm removal of selected worktrees" : `Remove ${selected.length} selected`}
						</Button>
					</div>
				)}
			</div>
			{(message || error) && (
				<InlineNotice className="mb-3" tone="error">
					{message || error}
				</InlineNotice>
			)}
		</FeatureGroup>
	)
}
