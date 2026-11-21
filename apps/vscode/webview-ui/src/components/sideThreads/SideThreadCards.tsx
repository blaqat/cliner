import type { ClineMessage, TurnPhase } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { sideThreadAnswer, sideThreadAnswerText } from "@shared/sideThreads"
import { MessageSquareDashedIcon, SplitIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { closeSideThread, keepSideQuestion, sendSideThreadNote } from "@/components/chat/chat-view/utils/asideUtils"
import { asideTitle } from "@/components/chat/chat-view/utils/threadUtils"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { openTask } from "@/components/inbox/sessionActions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { clearQuestion, useSideThreadSlots } from "./sideThreadStore"
import { isPhaseRunning, useSideThreadView, useWrapUp } from "./useSideThread"

export const LINK_BUTTON_CLASS =
	"inline-flex h-4.5 shrink-0 cursor-pointer items-center gap-0.75 whitespace-nowrap rounded-xs border-0 bg-transparent px-1.5 text-[11px] text-link hover:bg-toolbar-hover disabled:cursor-not-allowed disabled:opacity-50"
const PRIMARY_BUTTON_CLASS =
	"inline-flex h-5 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-xs border-0 bg-button-background px-2 text-[11px] text-button-foreground hover:bg-button-hover disabled:cursor-not-allowed disabled:opacity-50"
const SECONDARY_BUTTON_CLASS =
	"inline-flex h-5 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-xs border border-editor-group-border bg-button-secondary-background px-2 text-[11px] text-button-secondary-foreground hover:bg-button-secondary-background-hover disabled:cursor-not-allowed disabled:opacity-50"
const ICON_BUTTON_CLASS =
	"flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

/** Walks up through side threads to the thread that isn't one. */
export function mainThreadOf(item: HistoryItem | undefined, history: readonly HistoryItem[]): HistoryItem | undefined {
	let node = item
	const seen = new Set<string>()
	while (node?.parentTaskId && !node.isSubagent && !seen.has(node.id)) {
		seen.add(node.id)
		const parent = history.find((entry) => entry.id === node?.parentTaskId)
		if (!parent || parent.isSubagent) return undefined
		node = parent
	}
	return node && node.id !== item?.id ? node : undefined
}

// ---- Wrap up ----

interface WrapUpCardProps {
	sideId: string
	messages: readonly ClineMessage[]
	phase: TurnPhase | undefined
	/** After the note is sent and the side thread closed. */
	onDone?: () => void
}

/**
 * "Send this to main?": the side thread's wrap-up answer as a draft note, like the notebook
 * wrap-up card. Nothing reaches Main until Send; Discard keeps the side thread going.
 */
export const WrapUpCard = ({ sideId, messages, phase, onDone }: WrapUpCardProps) => {
	const wrap = useWrapUp(sideId, messages, phase)
	const [editing, setEditing] = useState(false)
	const [text, setText] = useState("")
	useEffect(() => {
		if (wrap.ready) setText(wrap.draft)
	}, [wrap.ready, wrap.draft])
	if (!wrap.asked) return null
	if (wrap.drafting)
		return (
			<div
				className="flex items-center gap-1.5 rounded-xs border border-editor-group-border bg-(--vscode-editor-background) px-2 py-1.5 text-[11.5px] text-description"
				data-testid="wrap-up-card"
				role="status">
				<span
					aria-hidden
					className="codicon codicon-loading codicon-modifier-spin text-[12px] motion-reduce:animate-none"
				/>
				<span className="flex-1">Drafting a note for main…</span>
				<button className={LINK_BUTTON_CLASS} onClick={wrap.discard} type="button">
					Cancel
				</button>
			</div>
		)
	return (
		<div
			className="flex flex-col gap-1.5 rounded-xs border border-editor-group-border bg-(--vscode-editor-background) px-2 py-1.5"
			data-testid="wrap-up-card">
			<div className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-semibold">
				<span aria-hidden className="codicon codicon-reply text-[12px]" />
				<span className="flex-1">Send this to main?</span>
			</div>
			{editing ? (
				<textarea
					aria-label="Note to main"
					className="min-h-16 w-full resize-y rounded-xs border border-input-border bg-input-background px-1.5 py-1 font-[inherit] text-[12px] text-input-foreground focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"
					maxLength={4000}
					onChange={(event) => setText(event.target.value)}
					value={text}
				/>
			) : (
				<div className="max-h-40 overflow-y-auto rounded-xs border border-input-border bg-input-background px-1.5 py-1 text-[12px] whitespace-pre-wrap break-words">
					{text}
				</div>
			)}
			{wrap.error && (
				<div className="text-[11px] text-error" role="alert">
					{wrap.error}
				</div>
			)}
			<div className="flex items-center gap-1">
				<button
					className={PRIMARY_BUTTON_CLASS}
					disabled={wrap.busy || !text.trim()}
					onClick={() => void wrap.send(text).then((sent) => sent && onDone?.())}
					title="Main reads it at its next step; this side thread then closes"
					type="button">
					Send to main
				</button>
				<button className={SECONDARY_BUTTON_CLASS} onClick={() => setEditing((value) => !value)} type="button">
					{editing ? "Done editing" : "Edit"}
				</button>
				<span className="flex-1" />
				<button className={LINK_BUTTON_CLASS} onClick={wrap.discard} type="button">
					Discard
				</button>
			</div>
		</div>
	)
}

/** The Wrap up button: one model call the user clicked; shows why when it can't start. */
export const WrapUpButton = ({
	sideId,
	messages,
	phase,
}: {
	sideId: string
	messages: readonly ClineMessage[]
	phase: TurnPhase | undefined
}) => {
	const wrap = useWrapUp(sideId, messages, phase)
	const running = isPhaseRunning(phase)
	return (
		<>
			<button
				className={LINK_BUTTON_CLASS}
				data-testid="wrap-up-button"
				disabled={wrap.asked || running}
				onClick={() => void wrap.start()}
				title={
					running
						? "Wrap up after this reply finishes"
						: "Draft a short note for main from this side thread; you approve it before it's sent"
				}
				type="button">
				<span aria-hidden className="codicon codicon-check text-[12px]" />
				Wrap up
			</button>
			{wrap.error && (
				<span className="min-w-0 truncate text-[11px] text-error" role="alert" title={wrap.error}>
					{wrap.error}
				</span>
			)}
		</>
	)
}

// ---- Own view: the line under the header ----

/**
 * In a side thread's own view: whose side thread it is, Main's live status, and Wrap up.
 * Closing (×) is the strip chip or the panel row; here the line leads back to Main.
 */
export const SideThreadBanner = () => {
	const { currentTaskItem, taskHistory, sessionStatuses, clineMessages, turnState } = useExtensionState()
	const history = taskHistory ?? []
	if (!currentTaskItem?.parentTaskId || currentTaskItem.isSubagent) return null
	const main = mainThreadOf(currentTaskItem, history)
	const mainStatus = main ? sessionStatuses?.[main.id] : undefined
	return (
		<div
			className="mx-4 mb-1 flex min-w-0 items-center gap-1.25 rounded-xs border border-editor-group-border py-0.5 pr-0.5 pl-2 text-[11px] text-description"
			data-testid="side-thread-banner">
			<SplitIcon aria-hidden className="size-3 shrink-0" />
			<span className="shrink-0">{currentTaskItem.sideKind === "btw" ? "Side question of" : "Side thread of"}</span>
			{main ? (
				<button
					className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
					onClick={() => void openTask(main.id)}
					title="Back to main"
					type="button">
					Main
				</button>
			) : (
				<span>a thread that's gone</span>
			)}
			{mainStatus === "running" && <span className="shrink-0">· running</span>}
			{mainStatus === "waiting" && <span className="shrink-0 text-warning">· needs you</span>}
			<span className="flex-1" />
			{main && <WrapUpButton messages={clineMessages ?? []} phase={turnState?.phase} sideId={currentTaskItem.id} />}
		</div>
	)
}

/** Own view: the wrap-up draft above the composer; sending returns to Main. */
export const OwnViewWrapUpCard = () => {
	const { currentTaskItem, taskHistory, clineMessages, turnState } = useExtensionState()
	if (!currentTaskItem?.parentTaskId || currentTaskItem.isSubagent) return null
	const main = mainThreadOf(currentTaskItem, taskHistory ?? [])
	return (
		<div className="mx-4 mb-1.5">
			<WrapUpCard
				messages={clineMessages ?? []}
				onDone={() => main && void openTask(main.id)}
				phase={turnState?.phase}
				sideId={currentTaskItem.id}
			/>
		</div>
	)
}

// ---- /btw ----

/**
 * The /btw card above the composer: a side question answered without interrupting Main.
 * It isn't part of Main's transcript; Send to main is the only way its answer gets there.
 * Keep turns it into a side thread; × or Esc closes it (it stays under Main in the panel).
 */
export const SideQuestionCard = () => {
	const { currentTaskItem } = useExtensionState()
	const { question } = useSideThreadSlots()
	const threadId = currentTaskItem?.id
	const questionId = threadId ? question[threadId] : undefined
	const { item, view } = useSideThreadView(questionId)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const cardRef = useRef<HTMLDivElement>(null)
	if (!threadId || !questionId) return null
	const messages = view?.messages ?? []
	const running = !view || isPhaseRunning(view.phase)
	const answer = sideThreadAnswer(messages)
	const answerText = sideThreadAnswerText(answer)
	const asked = messages.find((message) => message.say === "user_feedback" || message.say === "task")?.text
	const title = asked ?? (item ? asideTitle(item) : "Side question")
	const failed = [...messages].reverse().find((message) => message.say === "error" || message.ask === "api_req_failed")

	const act = async (action: () => Promise<void>) => {
		setBusy(true)
		setError(undefined)
		try {
			await action()
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure))
		} finally {
			setBusy(false)
		}
	}
	const close = () =>
		act(async () => {
			clearQuestion(threadId)
			await closeSideThread(questionId)
		})

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Esc anywhere in the card closes it
		<div
			aria-label="Side question"
			className="mx-4 mb-1.5 flex flex-col rounded-sm border border-editor-group-border bg-(--vscode-editor-background)"
			data-testid="side-question-card"
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault()
					void close()
				}
			}}
			ref={cardRef}
			role="region">
			<div className="flex min-w-0 items-center gap-1.5 border-0 border-b border-solid border-editor-group-border py-1 pr-1 pl-2 text-[11.5px]">
				<MessageSquareDashedIcon aria-hidden className="size-3 shrink-0 text-description" />
				<b className="shrink-0 font-semibold">Side question</b>
				<span className="min-w-0 flex-1 truncate text-description" title={title}>
					{title}
				</span>
				<button
					aria-label="Close the side question"
					className={ICON_BUTTON_CLASS}
					onClick={() => void close()}
					title="Close (Esc)"
					type="button">
					<span aria-hidden className="codicon codicon-close text-[13px]" />
				</button>
			</div>
			<div className="max-h-56 overflow-y-auto px-2 py-1.5 text-[12px]">
				{answerText ? (
					<MarkdownBlock compact markdown={answerText} showCursor={!!answer?.partial} />
				) : failed ? (
					<span className="text-error">
						{failed.text?.split("\n")[0] || "It couldn't answer."} Keep it as a side thread to try again there.
					</span>
				) : (
					<span className="flex items-center gap-1.5 text-description" role="status">
						<span
							aria-hidden
							className={cn(
								"codicon text-[12px]",
								running ? "codicon-loading codicon-modifier-spin motion-reduce:animate-none" : "codicon-info",
							)}
						/>
						{running ? "Thinking… Main keeps going." : "It finished without an answer. Keep it to ask again."}
					</span>
				)}
			</div>
			{error && (
				<div className="px-2 pb-1 text-[11px] text-error" role="alert">
					{error}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-0.5 px-1 pb-1">
				<button
					className={LINK_BUTTON_CLASS}
					disabled={busy || !answerText || running}
					onClick={() =>
						void act(async () => {
							await sendSideThreadNote(questionId, answerText)
							clearQuestion(threadId)
							await closeSideThread(questionId)
						})
					}
					title={
						running
							? "Send it once the answer is done"
							: "Send this answer to main as a note it reads at its next step"
					}
					type="button">
					<span aria-hidden className="codicon codicon-reply text-[12px]" />
					Send to main
				</button>
				<button
					className={LINK_BUTTON_CLASS}
					disabled={busy}
					onClick={() => void act(() => keepSideQuestion(threadId, questionId))}
					title="Keep it as a side thread you can keep working in"
					type="button">
					<SplitIcon aria-hidden className="size-3" />
					Keep as side thread
				</button>
				<span className="flex-1" />
				<kbd className={cn("px-1 text-[10px] text-description")}>Esc</kbd>
			</div>
		</div>
	)
}
