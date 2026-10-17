import { useWorktree } from "./useWorktree"

export function WorktreeToggle() {
	const { enabled, availability, setEnabled, error, busy } = useWorktree()
	return (
		<div className="space-y-1">
			<label className="flex items-center gap-2 text-xs" title={availability?.reason}>
				<input
					checked={enabled}
					disabled={busy || (!enabled && !availability?.available)}
					onChange={(event) => void setEnabled(event.target.checked)}
					type="checkbox"
				/>
				<span>Run in worktree{availability?.mode === "mm" ? " · mm" : ""}</span>
			</label>
			{(error || availability?.reason) && (
				<p className="m-0 text-xs text-description" role={error ? "alert" : undefined}>
					{error || availability?.reason}
				</p>
			)}
		</div>
	)
}
