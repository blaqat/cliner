import { SplitIcon } from "lucide-react"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { closeSideThread, sendToSideThread } from "@/components/chat/chat-view/utils/asideUtils"
import { asideTitle } from "@/components/chat/chat-view/utils/threadUtils"
import { openTask } from "@/components/inbox/sessionActions"
import { StatusDot } from "@/components/threadPanel/ThreadPanel"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { WrapUpButton, WrapUpCard } from "./SideThreadCards"
import { SideThreadTranscript } from "./SideThreadTranscript"
import { clearBeside } from "./sideThreadStore"
import { isPhaseRunning, useSideThreadView } from "./useSideThread"

const ICON_BUTTON_CLASS =
	"flex size-5.5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

/**
 * A side thread beside Main in the panel column (wide only): its own rows, Wrap up, and a
 * small composer that sends to it without leaving Main. ⤢ opens it full width (Act, approvals).
 */
export const SideThreadColumn = ({ mainId, sideId }: { mainId: string; sideId: string }) => {
	const { sessionStatuses } = useExtensionState()
	const { item, view } = useSideThreadView(sideId)
	const [draft, setDraft] = useState("")
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string>()
	const scrollRef = useRef<HTMLDivElement>(null)
	const messages = view?.messages ?? []
	const running = isPhaseRunning(view?.phase)
	const status = sessionStatuses?.[sideId] ?? (running ? "running" : "done")
	const title = item ? asideTitle(item) : "Side thread"

	// Follow the newest row, like the chat.
	const lastKey = `${messages.length}:${messages.at(-1)?.text?.length ?? 0}`
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when a row arrives or grows
	useEffect(() => {
		const element = scrollRef.current
		if (element) element.scrollTop = element.scrollHeight
	}, [lastKey])

	const openFull = () => {
		clearBeside(mainId)
		void openTask(sideId)
	}
	const close = () => {
		clearBeside(mainId)
		void closeSideThread(sideId).catch((failure) => console.error("Failed to close side thread:", failure))
	}
	const send = async () => {
		const text = draft.trim()
		if (!text || sending) return
		setSending(true)
		setError(undefined)
		try {
			await sendToSideThread(sideId, text)
			setDraft("")
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure))
		} finally {
			setSending(false)
		}
	}
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault()
			void send()
		}
	}

	if (!item)
		return (
			<div className="flex flex-col items-start gap-1.5 p-3 text-[12px] text-description">
				<span>This side thread was deleted.</span>
				<button
					className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-link hover:underline"
					onClick={() => clearBeside(mainId)}
					type="button">
					Hide this column
				</button>
			</div>
		)

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="side-thread-column">
			<div className="flex h-10 shrink-0 items-center gap-1.5 border-0 border-b border-solid border-border-panel pr-1.5 pl-3">
				<SplitIcon aria-hidden className="size-3 shrink-0 text-description" />
				<span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={title}>
					{title}
				</span>
				<StatusDot status={status} />
				<button
					aria-label="Hide the side thread"
					className={ICON_BUTTON_CLASS}
					onClick={() => clearBeside(mainId)}
					title="Hide it (it keeps going; reopen it from This thread › Agents)"
					type="button">
					<span aria-hidden className="codicon codicon-chrome-minimize text-[14px]" />
				</button>
				<button
					aria-label="Open full width"
					className={ICON_BUTTON_CLASS}
					onClick={openFull}
					title="Open full width (switch to Act, approvals)"
					type="button">
					<span aria-hidden className="codicon codicon-screen-full text-[14px]" />
				</button>
				<button
					aria-label="Close the side thread"
					className={ICON_BUTTON_CLASS}
					onClick={close}
					title="Close it (stops it; it stays listed under This thread › Agents)"
					type="button">
					<span aria-hidden className="codicon codicon-close text-[14px]" />
				</button>
			</div>
			<div className="flex shrink-0 items-center gap-1 px-3 pt-1.5 text-[11px] text-description">
				<span
					className="min-w-0 flex-1 truncate"
					title="It reads Main and answers in Ask; open it full width to let it edit">
					Beside Main · Ask
				</span>
				<WrapUpButton messages={messages} phase={view?.phase} sideId={sideId} />
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" ref={scrollRef}>
				{view ? (
					messages.length ? (
						<SideThreadTranscript messages={messages} onOpenFull={openFull} running={running} />
					) : (
						<span className="text-[12px] text-description">Ask it anything here. Main keeps going.</span>
					)
				) : (
					<span className="flex items-center gap-1.5 text-[12px] text-description">
						<span
							aria-hidden
							className="codicon codicon-loading codicon-modifier-spin text-[12px] motion-reduce:animate-none"
						/>
						Loading…
					</span>
				)}
				<div className="mt-2">
					<WrapUpCard messages={messages} onDone={() => clearBeside(mainId)} phase={view?.phase} sideId={sideId} />
				</div>
			</div>
			<div className="shrink-0 px-2 pt-1 pb-2">
				{error && (
					<div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] text-error" role="alert">
						<span className="min-w-0 flex-1">Couldn't send: {error}</span>
						<button
							className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
							onClick={() => void send()}
							type="button">
							Retry
						</button>
						<button
							className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
							onClick={openFull}
							type="button">
							Open full width
						</button>
					</div>
				)}
				<div
					className={cn(
						"flex items-end gap-1 rounded-xs border border-input-border bg-input-background px-1.5 py-1 focus-within:border-(--vscode-focusBorder)",
					)}>
					<textarea
						aria-label="Message the side thread"
						className="max-h-32 min-h-5 flex-1 resize-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-input-foreground outline-none placeholder:text-input-placeholder"
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Ask the side thread…"
						rows={1}
						value={draft}
					/>
					<button
						aria-label="Send to the side thread"
						className={cn(ICON_BUTTON_CLASS, "size-5")}
						disabled={!draft.trim() || sending}
						onClick={() => void send()}
						title="Send (Enter)"
						type="button">
						<span aria-hidden className="codicon codicon-send text-[13px]" />
					</button>
				</div>
			</div>
		</div>
	)
}
