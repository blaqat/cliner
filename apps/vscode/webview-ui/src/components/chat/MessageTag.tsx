import { type MessageReferenceInfo, messageReferenceSource } from "@shared/message-references"
import { ResolveMessageLinkRequest } from "@shared/proto/cline/task"
import { ArrowUpRightIcon, LinkIcon, XIcon } from "lucide-react"
import React, { memo } from "react"
import { openTask } from "@/components/inbox/sessionActions"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import type { MessageTagDraft } from "./chat-view/types/chatTypes"

interface MessageTagProps {
	tag: Pick<MessageTagDraft, "source" | "text">
	/** Omitted for a read-only chip (a tag on a sent message). */
	onRemove?: () => void
	/** Click opens the linked message (sent messages); the hover card says where. */
	onOpen?: { threadTitle: string; open: () => void }
	/** On a sent message's badge-coloured bubble: drawn in the bubble's own text colour so it stays readable. */
	onBubble?: boolean
	triggerRef?: React.Ref<HTMLButtonElement>
}

/**
 * Compact chip for one pasted message link. Unlike a quote it has no note: it
 * only connects the linked message to the next send as context. Hover (or
 * focus) shows the message; Backspace/Delete or the x removes it.
 *
 * Link-tinted with the link icon (the one on a message's copy-link button), so
 * it never reads as a grey quote chip. On a sent bubble it takes the bubble's
 * text colour instead (link blue vanishes on it) and click opens the message.
 */
export const MessageTag = memo(({ tag, onRemove, onOpen, onBubble = false, triggerRef }: MessageTagProps) => (
	<span
		className={cn(
			"group inline-flex h-5 shrink-0 items-center rounded-xs border text-xs",
			onBubble
				? "max-w-[240px] border-current/35 bg-black/20 text-inherit hover:border-current/70 focus-within:border-current/70"
				: "max-w-[200px] border-link/40 bg-link/10 text-foreground hover:border-link/70 focus-within:border-link/70",
		)}
		data-testid="message-tag">
		<HoverCard closeDelay={100} openDelay={200}>
			<HoverCardTrigger asChild>
				<button
					aria-label={`Message from ${tag.source}.${onOpen ? " Click to open it." : ""}${onRemove ? " Press Delete to remove." : ""}`}
					className={cn(
						"flex h-full min-w-0 items-center gap-1 border-0 bg-transparent py-0 pr-0.5 pl-1.5 text-inherit outline-none",
						onOpen ? "cursor-pointer" : "cursor-default",
					)}
					onClick={onOpen?.open}
					onKeyDown={(event) => {
						if (onRemove && (event.key === "Backspace" || event.key === "Delete")) {
							event.preventDefault()
							onRemove()
						}
					}}
					ref={triggerRef}
					type="button">
					<LinkIcon aria-hidden className={cn("shrink-0", !onBubble && "text-link")} size={11} />
					<span className="truncate" data-testid="message-tag-source">
						{tag.source}
					</span>
				</button>
			</HoverCardTrigger>
			<HoverCardContent align="start" className="w-80 max-w-[calc(100vw-2rem)] text-xs" side="top">
				<div className="flex flex-col gap-1" data-testid="message-tag-card">
					<span className="font-medium text-description">{tag.source}</span>
					<div
						className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words pr-1"
						data-testid="message-tag-text"
						tabIndex={0}>
						{tag.text}
					</div>
					{onOpen && (
						<button
							className="flex w-fit cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 text-link hover:underline"
							data-testid="message-tag-open"
							onClick={onOpen.open}
							type="button">
							{onOpen.threadTitle ? `Open in ${onOpen.threadTitle}` : "Open the message"}
							<ArrowUpRightIcon aria-hidden className="size-3" />
						</button>
					)}
				</div>
			</HoverCardContent>
		</HoverCard>
		{onRemove ? (
			<button
				aria-label="Remove message"
				className={cn(
					"flex h-full shrink-0 cursor-pointer items-center border-0 bg-transparent px-0.5",
					onBubble ? "text-inherit opacity-70 hover:opacity-100" : "text-description hover:text-foreground",
				)}
				onClick={(event) => {
					event.stopPropagation()
					onRemove()
				}}
				tabIndex={-1}
				title="Remove message"
				type="button">
				<XIcon size={11} />
			</button>
		) : (
			<span aria-hidden className="w-1" />
		)}
	</span>
))
MessageTag.displayName = "MessageTag"

/** Stable keys for id-less tags: the link target, so removals don't re-key the rest. */
function tagKey(tag: MessageTagDraft): string {
	return `${tag.threadId}:${tag.messageIndex}:${tag.toolCallId ?? ""}:${tag.block ?? ""}`
}

/** Whether two tags point at the same message (pasting the same link twice adds one chip). */
export function sameMessageTag(a: MessageTagDraft, b: MessageTagDraft): boolean {
	return tagKey(a) === tagKey(b)
}

interface MessageTagListProps {
	tags: MessageTagDraft[]
	setTags: React.Dispatch<React.SetStateAction<MessageTagDraft[]>>
	focusComposer: () => void
}

/** The message chips that sit in the composer's chip row, ahead of the quote chips. */
export const MessageTagList = ({ tags, setTags, focusComposer }: MessageTagListProps) => (
	<div className="flex shrink-0 items-center gap-1" data-testid="message-tag-list">
		{tags.map((tag, index) => (
			<MessageTag
				key={tagKey(tag)}
				onRemove={() => {
					setTags((current) => current.filter((_, i) => i !== index))
					focusComposer()
				}}
				tag={tag}
			/>
		))}
	</div>
)

interface MessageReferenceTagsProps {
	references: readonly MessageReferenceInfo[]
	/** Index-based removal; omit for read-only chips. */
	onRemove?: (index: number) => void
}

/** Opens the referenced message: scrolled to it when the reference knows where it is, else just its thread. */
export function openMessageReference(reference: MessageReferenceInfo): void {
	if (reference.messageIndex === undefined) {
		void openTask(reference.threadId)
		return
	}
	void TaskServiceClient.openMessageLink(
		ResolveMessageLinkRequest.create({
			threadId: reference.threadId,
			messageIndex: reference.messageIndex,
			toolCallId: reference.toolCallId,
			block: reference.block,
		}),
	).catch((error) => {
		console.error("Failed to open linked message:", error)
		void openTask(reference.threadId)
	})
}

/**
 * The tags attached to a sent message, drawn for the bubble they sit on.
 * Clicking one opens the linked message; clicks stay on the chips so they
 * don't open the bubble's editor.
 */
export const MessageReferenceTags = ({ references, onRemove }: MessageReferenceTagsProps) => (
	// biome-ignore lint/a11y/noStaticElementInteractions: only stops clicks from reaching the bubble's edit handler
	<div
		className="mb-1.5 flex flex-wrap items-center gap-1 whitespace-normal"
		data-testid="message-reference-tags"
		onClick={(event) => event.stopPropagation()}
		onKeyDown={(event) => event.stopPropagation()}>
		{references.map((reference, index) => (
			<MessageTag
				key={`${reference.threadId}:${index}`}
				onBubble
				onOpen={{ threadTitle: reference.threadTitle, open: () => openMessageReference(reference) }}
				onRemove={onRemove ? () => onRemove(index) : undefined}
				tag={{ source: messageReferenceSource(reference), text: reference.text }}
			/>
		))}
	</div>
)
