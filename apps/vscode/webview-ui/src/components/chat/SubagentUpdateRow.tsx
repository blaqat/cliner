import type { ClineMessage } from "@shared/ExtensionMessage"
import { AskResponseRequest } from "@shared/proto/cline/task"
import { SplitIcon } from "lucide-react"
import { type ReactNode, useState } from "react"
import { openSideThread } from "@/components/chat/chat-view/utils/asideUtils"
import { asideTitle } from "@/components/chat/chat-view/utils/threadUtils"
import { openTask } from "@/components/inbox/sessionActions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"

/** Long updates fold to this many characters until "Show all". */
const FOLD_AT = 280

const SUBAGENT_STATUS: Record<string, string> = { done: "finished", message: "says", failed: "failed", stopped: "stopped" }

/** Sent by "Send now": a visible message, so the turn it starts is one the user asked for. */
export const SEND_NOW_TEXT = "Go on with the side thread's note above."

function decode(text: string): string {
	return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
}

interface UpdateProps {
	icon: ReactNode
	from: string
	who: string
	onOpen?: () => void
	body: string
	footer?: ReactNode
}

/** One shape for "something came back to this thread": a subagent update or a side-thread note. */
const Update = ({ icon, from, who, onOpen, body, footer }: UpdateProps) => {
	const [expanded, setExpanded] = useState(false)
	const long = body.length > FOLD_AT
	const shown = long && !expanded ? `${body.slice(0, FOLD_AT).trimEnd()}…` : body
	return (
		<div
			className="rounded-r-xs border-0 border-l-2 border-solid border-(--vscode-textBlockQuote-border) bg-(--vscode-textBlockQuote-background) px-2 py-1.5 text-[12px]"
			data-testid="update-row">
			<div className="flex min-w-0 items-center gap-1.5 text-[11px] text-description">
				<span aria-hidden className="flex shrink-0 items-center">
					{icon}
				</span>
				<span className="shrink-0">{from}</span>
				{onOpen ? (
					<button
						className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[11px] text-link hover:underline"
						onClick={onOpen}
						title={`Open ${who}`}
						type="button">
						{who}
					</button>
				) : (
					<span className="min-w-0 truncate text-foreground">{who}</span>
				)}
			</div>
			<div className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{shown}</div>
			{(long || footer) && (
				<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-description">
					{footer}
					{long && (
						<button
							className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
							onClick={() => setExpanded((value) => !value)}
							type="button">
							{expanded ? "Show less" : "Show all"}
						</button>
					)}
				</div>
			)}
		</div>
	)
}

/** Whether Main has started a turn since the note arrived; notes are read at turn start. */
function deliveredAfter(messages: readonly ClineMessage[], ts: number | undefined): boolean {
	if (ts === undefined) return false
	const index = messages.findIndex((message) => message.ts === ts)
	return (
		index >= 0 &&
		messages
			.slice(index + 1)
			.some((message) => message.say === "api_req_started" || message.say === "user_feedback" || message.say === "task")
	)
}

/**
 * Transcript row for what came back to this thread: subagent updates and notes from side
 * threads, in one restyled row. A note waits for Main's next turn; it never starts one itself.
 */
export function SubagentUpdateRow({ text, message }: { text: string; message?: ClineMessage }) {
	const { taskHistory, clineMessages, turnState, currentTaskItem } = useExtensionState()
	const [sending, setSending] = useState(false)
	const history = taskHistory ?? []
	const sideNotes = [...text.matchAll(/<side_thread_update thread="([^"]+)">\s*([\s\S]*?)\s*<\/side_thread_update>/g)]
	if (sideNotes.length) {
		const running = turnState?.phase === "streaming" || turnState?.phase === "awaiting_approval"
		const delivered = deliveredAfter(clineMessages ?? [], message?.ts)
		const footer = delivered ? (
			<span>Main read it at its next step</span>
		) : running ? (
			<span>Main reads it at its next step</span>
		) : (
			<>
				<span className="text-warning">Waits for your next message</span>
				<button
					className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline disabled:opacity-50"
					disabled={sending}
					onClick={() => {
						setSending(true)
						TaskServiceClient.askResponse(
							AskResponseRequest.create({ responseType: "messageResponse", text: SEND_NOW_TEXT }),
						)
							.catch((error) => console.error("Failed to send now:", error))
							.finally(() => setSending(false))
					}}
					title="Starts Main's next turn with this note"
					type="button">
					Send now
				</button>
			</>
		)
		return (
			<div className="flex flex-col gap-1">
				{sideNotes.map(([, thread, body], index) => {
					const item = history.find((entry) => entry.id === thread)
					return (
						<Update
							body={decode(body)}
							footer={index === sideNotes.length - 1 ? footer : undefined}
							from={item?.sideKind === "btw" ? "From side question" : "From side thread"}
							icon={<SplitIcon className="size-3" />}
							key={`${thread}-${index}`}
							onOpen={
								item ? () => openSideThread(currentTaskItem?.id ?? item.parentTaskId ?? "", thread) : undefined
							}
							who={item ? asideTitle(item) : "a deleted side thread"}
						/>
					)
				})}
			</div>
		)
	}
	const updates = [...text.matchAll(/<subagent_update agent="([^"]+)" status="([^"]+)">\s*([\s\S]*?)\s*<\/subagent_update>/g)]
	if (!updates.length)
		return (
			<Update
				body={text}
				from="Subagent update"
				icon={<span className="codicon codicon-type-hierarchy-sub text-[12px]" />}
				who=""
			/>
		)
	return (
		<div className="flex flex-col gap-1">
			{updates.map(([, agent, status, body], index) => {
				const child = history.find((entry) => entry.isSubagent && (entry.agentId === agent || entry.id === agent))
				return (
					<Update
						body={body}
						footer={
							<span className={cn(status === "failed" && "text-error")}>
								{SUBAGENT_STATUS[status] ? `Subagent ${SUBAGENT_STATUS[status]}` : `Subagent ${status}`}
							</span>
						}
						from="From subagent"
						icon={<span className="codicon codicon-type-hierarchy-sub text-[12px]" />}
						key={`${agent}-${index}`}
						onOpen={child ? () => void openTask(child.id) : undefined}
						who={child?.task ?? agent}
					/>
				)
			})}
		</div>
	)
}
