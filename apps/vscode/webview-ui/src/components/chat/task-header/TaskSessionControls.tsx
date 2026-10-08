import { CheckIcon, LoaderCircleIcon, RotateCcwIcon } from "lucide-react"
import { countBackgroundRunning } from "@/components/inbox/inboxUtils"
import { toggleTaskSettled } from "@/components/inbox/sessionActions"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"

interface TaskSessionControlsProps {
	/** Returns to the inbox without stopping any session. */
	onShowInbox: () => void
}

/**
 * Header controls for the multi-session model: how many other chats are
 * running in the background (click for the inbox) and Settle / Unsettle.
 */
const TaskSessionControls = ({ onShowInbox }: TaskSessionControlsProps) => {
	const { currentTaskItem, sessionStatuses, taskHistory } = useExtensionState()
	const taskId = currentTaskItem?.id
	const backgroundRunning = countBackgroundRunning(sessionStatuses, taskId, taskHistory)
	const settled = !!currentTaskItem?.isSettled

	const stop = (event: React.SyntheticEvent) => {
		event.preventDefault()
		event.stopPropagation()
	}

	return (
		<div className="flex items-center gap-0.5">
			{backgroundRunning > 0 && (
				<Tooltip>
					<TooltipContent side="bottom">
						{backgroundRunning} other chat{backgroundRunning === 1 ? "" : "s"} running. Click for the inbox.
					</TooltipContent>
					<TooltipTrigger asChild>
						<button
							aria-label={`${backgroundRunning} running in background`}
							className="flex h-5 items-center gap-1 rounded-xs border-0 bg-transparent px-1 text-xs text-link hover:bg-toolbar-hover cursor-pointer"
							data-testid="background-running"
							onClick={(event) => {
								stop(event)
								onShowInbox()
							}}
							type="button">
							<LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" />
							{backgroundRunning}
						</button>
					</TooltipTrigger>
				</Tooltip>
			)}
			{taskId && (
				<Tooltip>
					<TooltipContent side="bottom">
						{settled ? "Move back to Active" : "Settle: move to the Settled list and return to the inbox"}
					</TooltipContent>
					<TooltipTrigger asChild>
						<Button
							aria-label={settled ? "Unsettle task" : "Settle task"}
							className="h-5 gap-1 px-1 text-xs text-description hover:text-foreground"
							data-testid="settle-task"
							onClick={(event) => {
								stop(event)
								void toggleTaskSettled(taskId).then(() => {
									if (!settled) {
										onShowInbox()
									}
								})
							}}
							size="xs"
							variant="icon">
							{settled ? <RotateCcwIcon className="size-3" /> : <CheckIcon className="size-3" />}
							{settled ? "Unsettle" : "Settle"}
						</Button>
					</TooltipTrigger>
				</Tooltip>
			)}
		</div>
	)
}

export default TaskSessionControls
