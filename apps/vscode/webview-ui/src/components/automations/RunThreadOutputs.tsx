import type { RecordedAutomationOutput } from "@shared/automations"
import { AnswerMissingAutomationOutputsRequest, ReadAutomationOutputRequest } from "@shared/proto/cline/automation"
import { useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { Button } from "@/components/ui/button"
import { AutomationServiceClient } from "@/services/grpc-client"

export function MissingOutputs({
	runId,
	threadId,
	names,
	onOpenThread,
}: {
	runId: string
	threadId: string
	names: string[]
	onOpenThread: (id: string) => void
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const answer = async (askAgain: boolean) => {
		setBusy(true)
		setError("")
		try {
			await AutomationServiceClient.answerMissingAutomationOutputs(
				AnswerMissingAutomationOutputsRequest.create({
					runId,
					threadId,
					askAgain,
				}),
			)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className="mt-1 rounded-xs bg-warning/10 px-1.5 py-1">
			<div className="break-words text-warning">Missing outputs: {names.join(", ")}</div>
			<div className="mt-1 flex flex-wrap items-center gap-1.5">
				<Button disabled={busy} onClick={() => void answer(true)} size="xs" variant="secondary">
					Ask it again
				</Button>
				<Button disabled={busy} onClick={() => void answer(false)} size="xs" variant="secondary">
					Continue without
				</Button>
				<LinkButton onClick={() => onOpenThread(threadId)}>Open thread</LinkButton>
			</div>
			{error && (
				<div className="mt-1 text-error" role="alert">
					{error}
				</div>
			)}
		</div>
	)
}

export function RunOutput({
	runId,
	stepId,
	output,
	onOpenNote,
}: {
	runId: string
	stepId: string
	output: RecordedAutomationOutput
	onOpenNote?: (slug: string) => void
}) {
	const [text, setText] = useState<string>()
	const [feedback, setFeedback] = useState("")
	const getValue = async (copy: boolean) => {
		setFeedback("")
		try {
			const { value } = await AutomationServiceClient.readAutomationOutput(
				ReadAutomationOutputRequest.create({
					runId,
					stepId,
					name: output.name,
				}),
			)
			if (copy) {
				await navigator.clipboard.writeText(value)
				setFeedback("Copied")
			} else setText(value)
		} catch (error) {
			setFeedback(error instanceof Error ? error.message : String(error))
		}
	}
	return (
		<li className="ph-no-capture my-1 min-w-0 rounded-xs border border-editor-group-border px-1.5 py-1">
			<div className="break-all font-mono text-[11px] font-medium">{output.name}</div>
			<div className="truncate text-description">{output.firstLine}</div>
			<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
				<LinkButton
					aria-expanded={text !== undefined}
					onClick={() => (text === undefined ? void getValue(false) : setText(undefined))}>
					{text === undefined ? "Open full text" : "Hide full text"}
				</LinkButton>
				<LinkButton onClick={() => void getValue(true)}>Copy</LinkButton>
				{feedback && (
					<span className="text-description" role="status">
						{feedback}
					</span>
				)}
			</div>
			{output.noteSlug && (
				<div className="break-all text-description">
					Saved as note{" "}
					{onOpenNote ? (
						<LinkButton onClick={() => onOpenNote(output.noteSlug!)}>{output.name}</LinkButton>
					) : (
						output.name
					)}
				</div>
			)}
			{text !== undefined && <pre className="m-0 mt-0.5 whitespace-pre-wrap break-words text-[11px]">{text}</pre>}
		</li>
	)
}
