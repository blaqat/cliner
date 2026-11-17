import type React from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { cn } from "@/lib/utils"

interface WorktreeCardProps {
	label: string
	title: string
	/** Codicon name without the `codicon-` prefix. */
	icon?: string
	iconClassName?: string
	onClose: () => void
	closeDisabled?: boolean
	children: React.ReactNode
}

/** The Worktrees page's inline create / merge / delete card (these used to be modals). */
export function WorktreeCard({ label, title, icon, iconClassName, onClose, closeDisabled, children }: WorktreeCardProps) {
	return (
		<section aria-label={label} className="my-3 rounded-xs border border-editor-group-border bg-code p-3">
			<div className="mb-2 flex items-center gap-1.5">
				{icon && <span aria-hidden className={cn(`codicon codicon-${icon} shrink-0 text-[14px]!`, iconClassName)} />}
				<h4 className="m-0 min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h4>
				<HeaderIconButton disabled={closeDisabled} icon="close" label="Close" onClick={onClose} />
			</div>
			{children}
		</section>
	)
}
