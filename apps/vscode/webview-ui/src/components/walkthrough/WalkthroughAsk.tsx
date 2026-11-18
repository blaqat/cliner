import type { WalkthroughAskConfig, WalkthroughAskThread } from "@shared/Walkthrough"
import { useRef, useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { Button } from "@/components/ui/button"
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
}

export const askTranscript = (thread: WalkthroughAskThread) =>
	thread.turns.map((turn) => `Question: ${turn.question}\nAnswer: ${turn.answer}`).join("\n\n")

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
	const unavailable =
		ask.disabledReason ??
		ask.config?.unavailable ??
		(!ask.config?.pick ? "Choose an Ask model in Settings > Models." : undefined)
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
				<Button
					className="mt-2"
					disabled={ask.isAdded(thread)}
					onClick={() => ask.addToSend(thread)}
					size="xs"
					title="Adds this conversation to your walkthrough notes. Send delivers it to the thread."
					variant="secondary">
					{ask.isAdded(thread) ? "Added to Send" : "Add to Send"}
				</Button>
			)}
			{!thread && (
				<LinkButton className="mt-2 block text-[11px]" onClick={() => setQuestion("Why this approach?")}>
					Why this approach?
				</LinkButton>
			)}
			<textarea
				aria-label={thread ? "Follow-up question" : "Question about selected lines"}
				className="mt-2 box-border w-full resize-y rounded-xs border border-solid border-input-border bg-input-background px-2 py-1 font-sans text-xs text-input-foreground focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"
				disabled={busy}
				maxLength={8000}
				onChange={(event) => setQuestion(event.target.value)}
				placeholder={thread ? "Ask a follow-up…" : "Ask about these lines…"}
				rows={2}
				value={question}
			/>
			<div className="mt-1 break-words text-[11px] text-description" data-testid="walkthrough-ask-uses">
				{ask.config && `${ask.config.label} · ${CONTEXT_LABEL[ask.config.context]}`}
			</div>
			{(error || unavailable) && (
				<div className="mt-1 text-[11px] text-error" role="alert">
					{error || unavailable}{" "}
					{ask.disabledReason && ask.refresh ? (
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
					{busy ? "Waiting for the model…" : "Stays here until you send it."}
				</span>
			</div>
		</section>
	)
}
