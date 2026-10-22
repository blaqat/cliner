import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { Loader2 } from "lucide-react"
import { memo, useCallback, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { Button } from "@/components/ui/button"
import { WorktreeCard } from "./WorktreeCard"

interface DeleteWorktreeCardProps {
	open: boolean
	onClose: () => void
	onConfirm: (deleteBranch: boolean) => Promise<void>
	worktreePath: string
	branchName: string
}

const DeleteWorktreeCard = ({ open, onClose, onConfirm, worktreePath, branchName }: DeleteWorktreeCardProps) => {
	const [isDeleting, setIsDeleting] = useState(false)
	const [deleteBranch, setDeleteBranch] = useState(false)

	const handleDelete = useCallback(async () => {
		setIsDeleting(true)
		try {
			await onConfirm(deleteBranch)
			onClose()
		} finally {
			setIsDeleting(false)
			setDeleteBranch(false)
		}
	}, [onConfirm, onClose, deleteBranch])

	if (!open) {
		return null
	}

	return (
		<WorktreeCard
			closeDisabled={isDeleting}
			icon="warning"
			iconClassName="text-error"
			label="Remove worktree"
			onClose={onClose}
			title="Delete Worktree">
			{/* Content */}
			<p className="text-sm text-[var(--vscode-descriptionForeground)] mt-0 mb-3">
				This will delete the worktree directory at{" "}
				<span className="font-semibold text-[var(--vscode-foreground)] break-all">{worktreePath}</span>
			</p>

			<label className="flex items-center gap-2 cursor-pointer mb-3">
				<VSCodeCheckbox
					checked={deleteBranch}
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

			{/* Buttons */}
			<div className="flex justify-end gap-2">
				<VSCodeButton appearance="secondary" disabled={isDeleting} onClick={onClose}>
					Cancel
				</VSCodeButton>
				<Button disabled={isDeleting} onClick={handleDelete} variant="danger">
					{isDeleting ? (
						<>
							<Loader2 className="w-4 h-4 mr-1 animate-spin" />
							Deleting...
						</>
					) : (
						"Delete"
					)}
				</Button>
			</div>
		</WorktreeCard>
	)
}

export default memo(DeleteWorktreeCard)
