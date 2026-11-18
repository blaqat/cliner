import { SplitIcon } from "lucide-react"
import { memo, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { startSideThread } from "./chat-view/utils/asideUtils"

interface AsideButtonProps {
	/** The side thread copies the conversation through this message. */
	messageTs: number
	className?: string
}

/**
 * Row action beside Copy: branches the conversation at this message into a side
 * thread (in Ask), beside Main when there's room, else in its own view. Main keeps running.
 */
const AsideButton = ({ messageTs, className }: AsideButtonProps) => {
	const { currentTaskItem } = useExtensionState()
	const [starting, setStarting] = useState(false)
	const taskId = currentTaskItem?.id
	if (!taskId) {
		return null
	}

	return (
		<Button
			aria-label="Side thread from here"
			className={cn("scale-90", className)}
			data-testid="aside-button"
			disabled={starting}
			onClick={(event) => {
				event.stopPropagation()
				setStarting(true)
				startSideThread({ taskId, messageTs })
					.catch((error) => console.error("Failed to start side thread:", error))
					.finally(() => setStarting(false))
			}}
			size="icon"
			title="Side thread from here (in Ask; Main keeps going)"
			variant="icon">
			<SplitIcon className="size-2" />
		</Button>
	)
}

export default memo(AsideButton)
