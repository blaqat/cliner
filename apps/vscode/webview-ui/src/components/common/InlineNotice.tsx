import type React from "react"
import { cn } from "@/lib/utils"

type NoticeTone = "error" | "warning" | "info"

const TONES: Record<NoticeTone, { box: string; icon: string }> = {
	error: {
		box: "border-(--vscode-inputValidation-errorBorder) bg-input-error-background",
		icon: "codicon-error text-error",
	},
	warning: {
		box: "border-(--vscode-inputValidation-warningBorder) bg-input-warning-background",
		icon: "codicon-warning text-warning",
	},
	info: { box: "border-editor-group-border bg-code", icon: "codicon-info text-description" },
}

interface InlineNoticeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
	tone: NoticeTone
	children: React.ReactNode
	/** Buttons on the right, e.g. an inline confirm's Revert / Cancel. */
	actions?: React.ReactNode
}

/**
 * The inline error / warning / confirm strip used instead of modals: a codicon, the message and
 * optional actions, in the input-validation colors. Errors announce as alerts, the rest as status.
 */
export function InlineNotice({ tone, children, actions, className, role, ...props }: InlineNoticeProps) {
	const { box, icon } = TONES[tone]
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-1.5 rounded-xs border border-solid px-2 py-1.5 text-xs text-foreground",
				box,
				className,
			)}
			role={role ?? (tone === "error" ? "alert" : "status")}
			{...props}>
			<span aria-hidden className={cn("codicon shrink-0 self-start text-[12px]! leading-4", icon)} />
			<span className="min-w-0 flex-1 break-words leading-4">{children}</span>
			{actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
		</div>
	)
}
