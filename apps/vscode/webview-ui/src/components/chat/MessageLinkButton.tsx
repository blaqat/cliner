import { BuildMessageLinkRequest } from "@shared/proto/cline/task"
import { CheckCheckIcon, LinkIcon } from "lucide-react"
import { memo, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"

interface MessageLinkButtonProps {
	/** The row's ClineMessage.ts — the host maps it to a stable transcript index. */
	messageTs: number
	className?: string
}

const COPIED_TIMEOUT = 1500

/**
 * Row action beside Copy/Aside: copies a vscode:// deep link that opens this
 * thread scrolled to this message. Pasted into the composer it becomes a
 * quote chip holding just this message's text.
 */
const MessageLinkButton = ({ messageTs, className }: MessageLinkButtonProps) => {
	const { currentTaskItem } = useExtensionState()
	const [state, setState] = useState<"idle" | "busy" | "copied">("idle")
	const taskId = currentTaskItem?.id
	if (!taskId) {
		return null
	}

	return (
		<Button
			aria-label={state === "copied" ? "Link copied" : "Copy link to this message"}
			className={cn("scale-90", className)}
			data-testid="message-link-button"
			disabled={state === "busy"}
			onClick={(event) => {
				event.stopPropagation()
				setState("busy")
				TaskServiceClient.buildMessageLink(BuildMessageLinkRequest.create({ threadId: taskId, messageTs }))
					.then((res) => navigator.clipboard.writeText(res.url))
					.then(() => {
						setState("copied")
						setTimeout(() => setState("idle"), COPIED_TIMEOUT)
					})
					.catch((error) => {
						console.error("Failed to copy message link:", error)
						setState("idle")
					})
			}}
			size="icon"
			title="Copy link to this message"
			variant="icon">
			{state === "copied" ? <CheckCheckIcon className="size-2" /> : <LinkIcon className="size-2" />}
		</Button>
	)
}

export default memo(MessageLinkButton)
