import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { Loader2 } from "lucide-react"
import { memo, useCallback, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { Button } from "@/components/ui/button"
import { WorktreeCard } from "./WorktreeCard"

interface DeleteWorktreeCardProps {
	open: boolean
	onClose: () => void
	onConfirm: (deleteBranch: boolean) => Promise<boolean>
	worktreePath: string
	branchName: string
	warning?: string
}

const DeleteWorktreeCard = ({ open, onClose, onConfirm, worktreePath, branchName, warning }: DeleteWorktreeCardProps) => {
	const [isDeleting, setIsDeleting] = useState(false)
	const [deleteBranch, setDeleteBranch] = useState(false)

	const close = useCallback(() => {
		setDeleteBranch(false)
		onClose()
	}, [onClose])

	const handleDelete = useCallback(async () => {
		setIsDeleting(true)
		try {
			if (await onConfirm(deleteBranch)) close()
		} finally {
			setIsDeleting(false)
		}
	}, [onConfirm, close, deleteBranch])

	if (!open) {
		return null
	}

	return (
		<WorktreeCard
			closeDisabled={isDeleting}
			icon="warning"
			iconClassName="text-error"
			label="Remove worktree"
			onClose={close}
			title="Delete Worktree">
			{/* Content */}
			<p className="text-sm text-[var(--vscode-descriptionForeground)] mt-0 mb-3">
				This will delete the worktree directory at{" "}
				<span className="font-semibold text-[var(--vscode-foreground)] break-all">{worktreePath}</span>
			</p>

			<label className="flex items-center gap-2 cursor-pointer mb-3">
				<VSCodeCheckbox
					checked={deleteBranch}
					disabled={!!warning || isDeleting}
					onChange={(e) => setDeleteBranch((e.target as HTMLInputElement).checked)}
				/>
				<span className="text-sm">
					Also delete branch <span className="font-semibold">{branchName}</span>
				</span>
			</label>

			{deleteBranch && (
				<InlineNotice className="mb-3" tone="warning">
					Warning: Unpushed commits on this branch will be lost.
				</InlineNotice>
			)}
			{warning && (
				<InlineNotice className="mb-3 whitespace-pre-line wrap-anywhere" tone="warning">
					{warning}
				</InlineNotice>
			)}

			{/* Buttons */}
			<div className="flex justify-end gap-2">
				<VSCodeButton appearance="secondary" disabled={isDeleting} onClick={close}>
					Cancel
				</VSCodeButton>
				<Button disabled={isDeleting} onClick={handleDelete} variant="danger">
					{isDeleting ? (
						<>
							<Loader2 className="w-4 h-4 mr-1 animate-spin" />
							Deleting...
						</>
					) : warning ? (
						"Confirm removal"
					) : (
						"Delete"
					)}
				</Button>
			</div>
		</WorktreeCard>
	)
}

export default memo(DeleteWorktreeCard)
