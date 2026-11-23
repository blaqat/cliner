import type { AutomationDefinition } from "@shared/automations"
import {
	type AutomationList,
	ProposeAutomationEditRequest,
	type ProposeAutomationEditResponse,
	SaveAutomationRequest,
} from "@shared/proto/cline/automation"
import { useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AutomationServiceClient } from "@/services/grpc-client"
import { PromptField } from "./BuilderStepEditor"

export function AutomationPromptEdit({
	path,
	editorDraft,
	onKeep,
	onDrop,
}: {
	path: string
	editorDraft?: { definition: AutomationDefinition; baseFingerprint?: string }
	onKeep: (list: AutomationList) => void
	onDrop: () => void
}) {
	const [request, setRequest] = useState("")
	const [proposal, setProposal] = useState<ProposeAutomationEditResponse>()
	const [busy, setBusy] = useState<"propose" | "keep">()
	const [error, setError] = useState("")
	const [fromDisk, setFromDisk] = useState(false)
	const canProposeFromDisk = !!editorDraft && !fromDisk && error.includes("Propose again from disk.")
	const propose = async (useDisk = fromDisk) => {
		setFromDisk(useDisk)
		setBusy("propose")
		setError("")
		setProposal(undefined)
		try {
			const draft = useDisk ? undefined : editorDraft
			setProposal(
				await AutomationServiceClient.proposeAutomationEdit(
					ProposeAutomationEditRequest.create({
						path,
						request,
						editorDefinitionJson: draft ? JSON.stringify(draft.definition) : undefined,
						editorBaseFingerprint: draft?.baseFingerprint,
					}),
				),
			)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(undefined)
		}
	}
	const keep = async () => {
		if (!proposal) return
		setBusy("keep")
		setError("")
		try {
			const list = await AutomationServiceClient.saveAutomation(
				SaveAutomationRequest.create({
					previousPath: path,
					expectedFingerprint: proposal.fingerprint,
					proposedFile: proposal.proposedFile,
				}),
			)
			onKeep(list)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(undefined)
		}
	}

	return (
		<div className="mx-auto w-full max-w-4xl px-4 pb-4" data-testid="automation-prompt-edit">
			<h2 className="mb-0 text-sm font-semibold">Change with a prompt</h2>
			<PromptField
				label="What should change?"
				onChange={(text) => {
					setRequest(text)
					setProposal(undefined)
					setError("")
				}}
				placeholder="Add a review step before the build."
				placeholders={[]}
				readOnly={!!busy}
				rows={3}
				value={request}
			/>
			<p className="my-1.5 text-[11px] text-description">
				{editorDraft && !fromDisk ? "Uses your current editor changes." : "Uses the file on disk."} Cline uses your
				background model to propose changes for you to review.
			</p>
			<div className="my-2 flex flex-wrap items-center gap-2">
				{canProposeFromDisk ? (
					<Button disabled={!!busy} onClick={() => void propose(true)} size="xs">
						Propose from disk
					</Button>
				) : (
					<Button
						disabled={!request.trim() || !!busy}
						onClick={() => void propose()}
						size="xs"
						variant={proposal ? "secondary" : "default"}>
						{busy === "propose" ? "Proposing…" : proposal ? "Propose again" : "Propose changes"}
					</Button>
				)}
				{proposal && (
					<Button
						disabled={!!busy || canProposeFromDisk || !!proposal.errors.length || !proposal.diff}
						onClick={() => void keep()}
						size="xs">
						{busy === "keep" ? "Keeping…" : "Keep"}
					</Button>
				)}
				<Button disabled={!!busy} onClick={onDrop} size="xs" variant="secondary">
					{proposal ? "Drop" : "Cancel"}
				</Button>
			</div>
			{error && <InlineNotice tone="error">{error}</InlineNotice>}
			{!!proposal?.errors.length && (
				<InlineNotice className="mb-2" tone="error">
					<div>Fix these in your request and propose again.</div>
					<ul className="mb-0 pl-4">
						{proposal.errors.map((issue, index) => (
							<li key={`${index}-${issue}`}>{issue}</li>
						))}
					</ul>
				</InlineNotice>
			)}
			{!!proposal?.guesses.length && (
				<ul className="mb-2 pl-4 text-[11px] text-description">
					{proposal.guesses.map((guess, index) => (
						<li key={`${index}-${guess}`}>{guess}</li>
					))}
				</ul>
			)}
			{proposal &&
				(proposal.diff ? (
					<pre
						aria-label="Proposed changes"
						className="ph-no-capture m-0 rounded-xs border border-editor-group-border py-1 font-mono text-[11px] leading-4"
						data-testid="automation-proposal-diff">
						{proposal.diff.split("\n").map((line, index) => (
							<span
								className={cn(
									"block whitespace-pre-wrap break-words px-1.5",
									line.startsWith("+")
										? "bg-(--vscode-diffEditor-insertedLineBackground)"
										: line.startsWith("-")
											? "bg-(--vscode-diffEditor-removedLineBackground)"
											: line.startsWith("@@")
												? "text-description"
												: undefined,
								)}
								key={`${index}-${line}`}>
								{line || " "}
							</span>
						))}
					</pre>
				) : (
					<p className="text-description">The proposal makes no changes.</p>
				))}
		</div>
	)
}
