import type { ClineMessage } from "@shared/ExtensionMessage"
import { AskResponseRequest } from "@shared/proto/cline/task"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

/** The decision id keeps these controls scoped even while siblings stream. */
export function SubagentDecisionControls({ message, compact = false }: { message: ClineMessage; compact?: boolean }) {
	const { currentTaskItem, pendingSubagentDecisions } = useExtensionState()
	const decision = pendingSubagentDecisions?.find((pending) => pending.message.decisionId === message.decisionId)
	const [sending, setSending] = useState(false)
	const [error, setError] = useState(false)
	const [answer, setAnswer] = useState("")
	if (!decision || !message.decisionId || !currentTaskItem) return null
	if (compact && decision.kind === "question") return null
	const respond = async (responseType: string, text?: string) => {
		setSending(true)
		setError(false)
		try {
			await TaskServiceClient.askResponse(
				AskResponseRequest.create({ taskId: currentTaskItem.id, decisionId: message.decisionId, responseType, text }),
			)
		} catch {
			setError(true)
		} finally {
			setSending(false)
		}
	}
	const buttonClass =
		"rounded-xs border border-editor-group-border bg-button-secondary-background px-2 py-1 text-[11px] text-button-secondary-foreground cursor-pointer hover:bg-button-secondary-background-hover disabled:opacity-50"
	return (
		<div className="flex flex-wrap items-center gap-1.5 py-1" data-testid="subagent-decision-controls">
			{decision.kind === "approval" ? (
				<>
					<button
						aria-label={`Approve ${decision.name}`}
						className={buttonClass}
						disabled={sending}
						onClick={() => void respond("yesButtonClicked")}
						type="button">
						Approve
					</button>
					<button
						aria-label={`Reject ${decision.name}`}
						className={buttonClass}
						disabled={sending}
						onClick={() => void respond("noButtonClicked")}
						type="button">
						Reject
					</button>
				</>
			) : (
				<form
					className="flex w-full gap-1.5"
					onSubmit={(event) => {
						event.preventDefault()
						if (answer.trim()) void respond("messageResponse", answer)
					}}>
					<input
						aria-label={`Answer ${decision.name}`}
						className="min-w-0 flex-1 rounded-xs border border-editor-group-border bg-input-background px-2 text-input-foreground"
						disabled={sending}
						onChange={(event) => setAnswer(event.target.value)}
						value={answer}
					/>
					<button className={buttonClass} disabled={sending || !answer.trim()} type="submit">
						Answer
					</button>
				</form>
			)}
			{error && (
				<span className="text-[11px] text-error" role="alert">
					Couldn't send. Try again.
				</span>
			)}
		</div>
	)
}
