import { SplitIcon } from "lucide-react"
import { memo, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { startAside } from "./chat-view/utils/asideUtils"

interface AsideButtonProps {
	/** The aside copies the conversation through this message. */
	messageTs: number
	className?: string
}

/**
 * Row action beside Copy: branches the conversation at this message into an
 * aside (opens in Ask; the main chat keeps running in the background).
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
			aria-label="Aside from here"
			className={cn("scale-90", className)}
			data-testid="aside-button"
			disabled={starting}
			onClick={(event) => {
				event.stopPropagation()
				setStarting(true)
				startAside({ taskId, messageTs })
					.catch((error) => console.error("Failed to start aside:", error))
					.finally(() => setStarting(false))
			}}
			size="icon"
			title="Aside: branch the conversation from here (opens in Ask)"
			variant="icon">
			<SplitIcon className="size-2" />
		</Button>
	)
}

export default memo(AsideButton)
