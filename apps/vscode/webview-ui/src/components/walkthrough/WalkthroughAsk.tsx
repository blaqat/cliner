import type { WalkthroughAskConfig, WalkthroughAskThread } from "@shared/Walkthrough"
import { type KeyboardEvent, useRef, useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { Button } from "@/components/ui/button"
import { modKeyLabel } from "@/utils/platformUtils"
import type { LineRange } from "./reviewState"
import { InlineCodeProse } from "./WalkthroughNote"

export type AskRange = LineRange & { quote?: string }
export interface DiffAsk {
	config?: WalkthroughAskConfig
	threads: WalkthroughAskThread[]
	disabledReason?: string
	ask: (range: AskRange, question: string, askId?: string) => Promise<void>
	addToSend: (thread: WalkthroughAskThread) => void
	isAdded: (thread: WalkthroughAskThread) => boolean
	openSettings: () => void
	refresh?: () => void
	/** Continues the conversation in a side thread of this walkthrough's thread; undefined when it can't. */
	openAsSideThread?: (thread: WalkthroughAskThread) => Promise<void>
}

export const askTranscript = (thread: WalkthroughAskThread) =>
	thread.turns.map((turn) => `Question: ${turn.question}\nAnswer: ${turn.answer}`).join("\n\n")

/** The first message of a side thread opened from an Ask why answer. */
export const askSideThreadPrompt = (path: string, thread: WalkthroughAskThread) =>
	[
		`From the walkthrough, about ${path}:`,
		thread.quote ? `\`\`\`\n${thread.quote}\n\`\`\`` : "",
		askTranscript(thread),
		"Let's keep talking about this here.",
	]
		.filter(Boolean)
		.join("\n\n")

const CONTEXT_LABEL = { thread: "This thread", recent: "Latest user turn", selection: "Selected lines only" }

/** The form has no model controls. Every request, including a follow-up, starts with Ask. */
export function WalkthroughAsk({
	ask,
	range,
	thread,
	onClose,
}: {
	ask: DiffAsk
	range: AskRange
	thread?: WalkthroughAskThread
	onClose?: () => void
}) {
	const [question, setQuestion] = useState("")
	const [busy, setBusy] = useState(false)
	const inFlight = useRef(false)
	const [error, setError] = useState("")
	const [opening, setOpening] = useState(false)
	const unavailable =
		ask.disabledReason ??
		ask.config?.unavailable ??
		(!ask.config?.pick ? "Ask why has no model yet. Choose one in Settings › Models." : undefined)
	const submit = async () => {
		if (!question.trim() || unavailable || inFlight.current) return
		inFlight.current = true
		setBusy(true)
		setError("")
		try {
			await ask.ask(range, question.trim(), thread?.id)
			setQuestion("")
			onClose?.()
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			inFlight.current = false
			setBusy(false)
		}
	}
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
			event.preventDefault()
			void submit()
		} else if (event.key === "Escape" && onClose && !busy) {
			event.preventDefault()
			onClose()
		}
	}
	const openAsSide = async () => {
		if (!thread || !ask.openAsSideThread || opening) return
		setOpening(true)
		setError("")
		try {
			await ask.openAsSideThread(thread)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setOpening(false)
		}
	}
	return (
		<section
			aria-label="Ask about selected lines"
			className="min-w-0 border-y border-x-0 border-l-2 border-solid border-y-editor-group-border border-l-link bg-code px-2 py-2 font-sans text-xs leading-normal"
			data-testid="walkthrough-ask">
			<div className="flex items-center gap-1 text-[11px] text-description">
				<span aria-hidden className="codicon codicon-sparkle text-[12px]!" />
				<span>Ask why</span>
				<span className="flex-1" />
				{onClose && !busy && <LinkButton onClick={onClose}>Close</LinkButton>}
			</div>
			{range.quote && (
				<div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-description">{range.quote}</div>
			)}
			{thread?.turns.map((turn, index) => (
				<div className="mt-2 min-w-0 break-words" key={index}>
					<div className="whitespace-pre-wrap text-description">You · {turn.question}</div>
					<InlineCodeProse className="mt-1 whitespace-pre-wrap text-foreground" text={turn.answer} />
				</div>
			))}
			{thread && (
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					<Button
						disabled={ask.isAdded(thread)}
						onClick={() => ask.addToSend(thread)}
						size="xs"
						title="Adds this conversation to your walkthrough notes. Send delivers it to the thread."
						variant="secondary">
						<span
							aria-hidden
							className={`codicon text-[12px]! ${ask.isAdded(thread) ? "codicon-check" : "codicon-add"}`}
						/>
						{ask.isAdded(thread) ? "Added to Send" : "Add to Send"}
					</Button>
					{ask.openAsSideThread && (
						<Button
							aria-busy={opening || undefined}
							disabled={opening || busy}
							onClick={() => void openAsSide()}
							size="xs"
							title="Starts a side thread of this thread with this question and answer as its first message. It replies once."
							variant="secondary">
							<span
								aria-hidden
								className={`codicon text-[12px]! ${opening ? "codicon-loading codicon-modifier-spin" : "codicon-comment-discussion"}`}
							/>
							Open as side thread
						</Button>
					)}
				</div>
			)}
			{!thread && (
				<LinkButton className="mt-2 block text-[11px]" onClick={() => setQuestion("Why this approach?")}>
					Why this approach?
				</LinkButton>
			)}
			<textarea
				aria-label={thread ? "Follow-up question" : "Question about selected lines"}
				// biome-ignore lint/a11y/noAutofocus: the box opens because the user chose Ask
				autoFocus={!thread}
				className="mt-2 box-border w-full resize-y rounded-xs border border-solid border-input-border bg-input-background px-2 py-1 font-sans text-xs text-input-foreground focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"
				disabled={busy}
				maxLength={8000}
				onChange={(event) => setQuestion(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={thread ? "Ask a follow-up…" : "Ask about these lines…"}
				rows={2}
				value={question}
			/>
			<div className="mt-1 break-words text-[11px] text-description" data-testid="walkthrough-ask-uses">
				{ask.config && `${ask.config.label} · ${CONTEXT_LABEL[ask.config.context]}`}
			</div>
			{(error || unavailable) && (
				<div className="mt-1 text-[11px] text-error" role="alert">
					{error ? `Couldn't get an answer: ${error}` : unavailable}{" "}
					{!error && ask.disabledReason && ask.refresh ? (
						<LinkButton onClick={ask.refresh}>Refresh walkthrough</LinkButton>
					) : (
						<LinkButton onClick={ask.openSettings}>Open Settings</LinkButton>
					)}
				</div>
			)}
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button
					aria-busy={busy || undefined}
					disabled={busy || !!unavailable || !question.trim()}
					onClick={() => void submit()}
					size="xs"
					title={
						unavailable ??
						(question.trim()
							? "Starts a model call using the model and context shown above. The answer stays on this walkthrough."
							: "Write a question to start a model call.")
					}>
					<span
						aria-hidden
						className={`codicon text-[12px]! ${busy ? "codicon-loading codicon-modifier-spin" : "codicon-sparkle"}`}
					/>
					{busy ? "Asking…" : thread ? "Ask follow-up" : "Ask"}
				</Button>
				<span className="text-[11px] text-description">
					{busy ? "Waiting for the model…" : `${modKeyLabel()}+Enter · the answer stays on this walkthrough`}
				</span>
			</div>
		</section>
	)
}
