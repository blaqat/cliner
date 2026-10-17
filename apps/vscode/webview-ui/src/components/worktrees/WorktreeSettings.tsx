import type { ThreadWorktreeSettings } from "@shared/thread-worktrees"
import { useState } from "react"
import { threadWorktreeAction, useWorktree } from "./useWorktree"

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
	if (!state || !settings) return error ? <p role="alert">{error}</p> : null
	return (
		<section aria-label="Worktrees" className="my-3 p-3 space-y-3 border border-editor-widget-border/50 rounded-md">
			<h3 className="m-0 text-sm">Worktrees</h3>
			<label className="flex items-center gap-2">
				Mode
				<select
					aria-label="Worktrees mode"
					className="bg-(--vscode-dropdown-background) text-foreground"
					disabled={busy}
					onChange={(event) => setDraft({ ...settings, mode: event.target.value as ThreadWorktreeSettings["mode"] })}
					value={settings.mode}>
					<option value="off">Off</option>
					<option value="git">Git worktree</option>
					<option value="mm">mm</option>
				</select>
			</label>
			{(settings.mode === "mm" || state.availability.hasMmrc) && (
				<>
					<label className="block text-xs">
						mm.js
						<input
							aria-label="Path to mm.js"
							className="block w-full bg-input-background text-input-foreground"
							onChange={(e) => setDraft({ ...settings, mmPath: e.target.value })}
							value={settings.mmPath}
						/>
					</label>
					<label className="block text-xs">
						node
						<input
							aria-label="Path to node"
							className="block w-full bg-input-background text-input-foreground"
							onChange={(e) => setDraft({ ...settings, nodePath: e.target.value })}
							value={settings.nodePath}
						/>
					</label>
				</>
			)}
			{draft && (
				<button
					disabled={busy}
					onClick={() =>
						void run(async () => {
							await threadWorktreeAction("configure", "", draft)
							setDraft(undefined)
						})
					}
					type="button">
					Save worktree settings
				</button>
			)}
			<p className="text-xs text-description m-0">
				Workspaces with .mmrc use mm automatically. In other workspaces, mm mode uses Git worktrees. New threads start in
				your workspace.
			</p>
			<label className="flex gap-2 text-xs">
				<input
					checked={state.availability.workspaceOff}
					disabled={busy}
					onChange={(event) =>
						void run(async () => {
							await threadWorktreeAction("workspaceOff", "", { disabled: event.target.checked })
						})
					}
					type="checkbox"
				/>
				Off for this workspace
			</label>
			{state.availability.reason && <p className="text-xs text-description">{state.availability.reason}</p>}
			<div className="text-xs">{state.settled.length} settled worktrees</div>
			{state.settled.map((mapping) => (
				<div key={mapping.threadId}>
					<label className="flex items-start gap-2 text-xs">
						<input
							checked={selected.includes(mapping.threadId)}
							disabled={busy}
							onChange={(event) =>
								setSelected(
									event.target.checked
										? [...selected, mapping.threadId]
										: selected.filter((id) => id !== mapping.threadId),
								)
							}
							type="checkbox"
						/>
						<span className="break-all">
							{mapping.branch}
							<span className="block text-description">
								{mapping.transferredDiff ? "Brought in / taken over" : "Never brought in"}
							</span>
						</span>
					</label>
					{warnings[mapping.threadId] && (
						<p className="text-xs" role="alert">
							{warnings[mapping.threadId]}
						</p>
					)}
				</div>
			))}
			{selected.length > 0 && (
				<button
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
					type="button">
					{Object.keys(warnings).length
						? "Confirm removal of selected worktrees"
						: `Remove ${selected.length} selected`}
				</button>
			)}
			{(message || error) && (
				<p className="text-xs" role="alert">
					{message || error}
				</p>
			)}
		</section>
	)
}
