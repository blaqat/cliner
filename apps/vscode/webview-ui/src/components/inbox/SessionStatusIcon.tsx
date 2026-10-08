import { CheckIcon, LoaderCircleIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SessionStatus } from "./inboxUtils"

const STATUS_LABEL: Record<SessionStatus, string> = {
	running: "Running",
	waiting: "Waiting for you",
	done: "Done",
	error: "Error",
}

const DOT_CLASS: Record<Exclude<SessionStatus, "running">, string> = {
	waiting: "bg-warning",
	done: "bg-success",
	error: "bg-error",
}

interface SessionStatusIconProps {
	status: SessionStatus
	settled?: boolean
	className?: string
}

/** Spinner while running, a colored dot otherwise, and a check once settled. */
export const SessionStatusIcon = ({ status, settled = false, className }: SessionStatusIconProps) => {
	if (settled) {
		return <CheckIcon aria-label="Settled" className={cn("size-3 shrink-0 text-description", className)} role="img" />
	}
	if (status === "running") {
		return (
			<LoaderCircleIcon
				aria-label={STATUS_LABEL.running}
				className={cn("size-3 shrink-0 animate-spin text-link motion-reduce:animate-none", className)}
				role="img"
			/>
		)
	}
	return (
		<span
			aria-label={STATUS_LABEL[status]}
			className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASS[status], className)}
			role="img"
		/>
	)
}
