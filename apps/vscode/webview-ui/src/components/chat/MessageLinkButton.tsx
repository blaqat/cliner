import { BuildMessageLinkRequest } from "@shared/proto/cline/task"
import { CheckCheckIcon, LinkIcon, TriangleAlertIcon } from "lucide-react"
import { memo, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"

interface MessageLinkButtonProps {
	/** The row's ClineMessage.ts — the host maps it to a stable transcript index. */
	messageTs: number
	className?: string
	/** Classes for the icon itself, e.g. to match a neighboring button's icon size. */
	iconClassName?: string
}

const COPIED_TIMEOUT = 1500

/** Clipboard write that survives the async gap after the host round trip (the user gesture may be spent by then). */
async function writeClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text)
		return
	} catch (error) {
		const textarea = document.createElement("textarea")
		textarea.value = text
		textarea.setAttribute("readonly", "")
		textarea.style.position = "fixed"
		textarea.style.opacity = "0"
		document.body.appendChild(textarea)
		textarea.select()
		const ok = document.execCommand?.("copy")
		textarea.remove()
		if (!ok) throw error
	}
}

/**
 * Row action beside Copy/Aside: copies a vscode:// deep link that opens this
 * thread scrolled to this message. Pasted into the composer it becomes a
 * message tag (context connection, not a quote) holding just this message.
 */
const MessageLinkButton = ({ messageTs, className, iconClassName }: MessageLinkButtonProps) => {
	const { currentTaskItem } = useExtensionState()
	const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle")
	const taskId = currentTaskItem?.id
	if (!taskId) {
		return null
	}

	return (
		<Button
			aria-label={state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy link" : "Copy link to this message"}
			className={cn("scale-90", className)}
			data-testid="message-link-button"
			disabled={state === "busy"}
			onClick={(event) => {
				event.stopPropagation()
				setState("busy")
				TaskServiceClient.buildMessageLink(BuildMessageLinkRequest.create({ threadId: taskId, messageTs }))
					.then((res) => writeClipboard(res.url))
					.then(() => {
						setState("copied")
						setTimeout(() => setState("idle"), COPIED_TIMEOUT)
					})
					.catch((error) => {
						console.error("Failed to copy message link:", error)
						setState("failed")
						setTimeout(() => setState("idle"), COPIED_TIMEOUT * 2)
					})
			}}
			size="icon"
			title={state === "failed" ? "Couldn't copy link to this message" : "Copy link to this message"}
			variant="icon">
			{state === "copied" ? (
				<CheckCheckIcon className={cn("size-2", iconClassName)} />
			) : state === "failed" ? (
				<TriangleAlertIcon className={cn("size-2 text-error", iconClassName)} />
			) : (
				<LinkIcon className={cn("size-2", iconClassName)} />
			)}
		</Button>
	)
}

export default memo(MessageLinkButton)
