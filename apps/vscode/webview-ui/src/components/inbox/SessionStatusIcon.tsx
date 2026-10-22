import { CheckIcon, HourglassIcon, LoaderCircleIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ThreadStatus } from "./threadStatus"

export const STATUS_LABEL: Record<ThreadStatus, string> = {
	running: "Running",
	waiting: "Waiting for you",
	subagents: "Waiting on subagents",
	done: "Done",
	error: "Error",
	stopped: "Stopped",
}

const DOT_CLASS: Record<Exclude<ThreadStatus, "running" | "subagents">, string> = {
	waiting: "bg-warning",
	done: "bg-success",
	error: "bg-error",
	stopped: "bg-description",
}

interface SessionStatusIconProps {
	status: ThreadStatus
	settled?: boolean
	className?: string
	/** Overrides the label (aria-label and tooltip), e.g. "Waiting on 2 subagents". */
	label?: string
}

/**
 * Spinner while running, an hourglass while waiting on subagents, a colored dot
 * otherwise, and a check once settled.
 */
export const SessionStatusIcon = ({ status, settled = false, className, label }: SessionStatusIconProps) => {
	if (settled) {
		return <CheckIcon aria-label="Settled" className={cn("size-3 shrink-0 text-description", className)} role="img" />
	}
	const text = label ?? STATUS_LABEL[status]
	if (status === "running") {
		return (
			<LoaderCircleIcon
				aria-label={text}
				className={cn("size-3 shrink-0 animate-spin text-link motion-reduce:animate-none", className)}
				role="img"
			/>
		)
	}
	if (status === "subagents") {
		return (
			<HourglassIcon
				aria-label={text}
				className={cn("size-3 shrink-0 text-(--vscode-charts-purple)", className)}
				data-status="subagents"
				role="img">
				<title>{text}</title>
			</HourglassIcon>
		)
	}
	return (
		<span
			aria-label={text}
			className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASS[status], className)}
			role="img"
		/>
	)
}
