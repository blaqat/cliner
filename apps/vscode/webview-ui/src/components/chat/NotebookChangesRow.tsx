import type { ClineMessage } from "@shared/ExtensionMessage"
import { ApplyNotebookChangesRequest, DiscardNotebookChangesRequest, NotebookActionRequest } from "@shared/proto/cline/task_group"
import type { NotebookChange, NotebookChangesPayload } from "@shared/task-groups"
import { useMemo, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { NotebookDiff } from "@/components/taskGroup/NotebookDiff"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskGroupServiceClient } from "@/services/grpc-client"

/** Parses a `notebook_changes` message text. Anything malformed returns null so the row renders nothing. */
export function parseNotebookChangesPayload(text: string | undefined): NotebookChangesPayload | null {
	if (!text) return null
	try {
		const parsed = JSON.parse(text) as Partial<NotebookChangesPayload> | null
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.taskGroupId !== "string" ||
			typeof parsed.threadId !== "string" ||
			!Array.isArray(parsed.changes)
		) {
			return null
		}
		const status = parsed.status === "applied" || parsed.status === "discarded" ? parsed.status : "pending"
		const changes = parsed.changes.filter(
			(change): change is NotebookChange =>
				!!change && typeof change === "object" && typeof change.slug === "string" && typeof change.name === "string",
		)
		const appliedSlugs = Array.isArray(parsed.appliedSlugs)
			? parsed.appliedSlugs.filter((slug): slug is string => typeof slug === "string")
			: undefined
		return {
			revision: typeof parsed.revision === "string" ? parsed.revision : "",
			taskGroupId: parsed.taskGroupId,
			threadId: parsed.threadId,
			status,
			changes,
			appliedSlugs,
		}
	} catch {
		return null
	}
}

/** A note this thread wrote: solid purple chip with a pencil, matching the task page timeline. */
export function WroteNoteChip({ name }: { name: string }) {
	return (
		<span className="inline-flex max-w-40 min-w-0 items-center gap-1 rounded-xs border border-[color-mix(in_srgb,var(--vscode-charts-purple)_45%,transparent)] bg-[color-mix(in_srgb,var(--vscode-charts-purple)_15%,transparent)] px-1.5 text-[11px] leading-4">
			<i aria-hidden className="codicon codicon-edit text-[10px]!" />
			<span className="truncate">{name}</span>
		</span>
	)
}

interface NotebookChangesRowProps {
	message: ClineMessage
	/** Opens the task page; defaults to the sidebar task page navigation. */
	onOpenTaskGroup?: (taskGroupId: string) => void
}

/**
 * Wrap-up card for notebook changes staged during a thread. Only the newest
 * card for each group in the thread is interactive; older pending ones collapse to a
 * "superseded" line, and resolved ones to a one-line summary.
 */
export function NotebookChangesRow({ message, onOpenTaskGroup }: NotebookChangesRowProps) {
	const { clineMessages, navigateToTaskGroup, taskGroups } = useExtensionState()
	const openTaskGroup = onOpenTaskGroup ?? navigateToTaskGroup
	const payload = useMemo(() => parseNotebookChangesPayload(message.text), [message.text])
	const isNewest = useMemo(() => {
		for (let i = clineMessages.length - 1; i >= 0; i--) {
			if (clineMessages[i].say === "notebook_changes") {
				const candidate = parseNotebookChangesPayload(clineMessages[i].text)
				if (candidate?.taskGroupId === payload?.taskGroupId && candidate?.threadId === payload?.threadId)
					return clineMessages[i].ts === message.ts
			}
		}
		return true
	}, [clineMessages, message.ts, payload?.taskGroupId, payload?.threadId])
	// Shown right after Apply/Discard succeeds, until the backend rewrites the message status.
	const [rowError, setRowError] = useState<string | null>(null)
	const [resolved, setResolved] = useState<Pick<NotebookChangesPayload, "status" | "appliedSlugs"> | null>(null)

	if (!payload) return null
	const status = payload.status === "pending" ? (resolved?.status ?? payload.status) : payload.status
	if (status !== "pending") {
		const appliedSlugs = payload.status === "pending" ? resolved?.appliedSlugs : payload.appliedSlugs
		return (
			<div>
				<NotebookSummaryRow
					changes={
						status === "applied"
							? appliedSlugs
								? payload.changes.filter((change) => appliedSlugs.includes(change.slug))
								: payload.changes
							: []
					}
					onOpenTask={() => openTaskGroup?.(payload.taskGroupId)}
					status={status}
				/>
				<NotebookUserEdits changes={payload.changes} />
			</div>
		)
	}
	if (!isNewest || payload.changes.length === 0) {
		return (
			<div className="flex items-center gap-1.5 text-xs text-description" data-testid="notebook-changes-superseded">
				<i aria-hidden className="codicon codicon-book" />
				<span>Notebook changes superseded by a later review</span>
				{rowError && (
					<span className="text-error" role="alert">
						{rowError}
					</span>
				)}
			</div>
		)
	}
	return (
		<NotebookChangesCard
			key={`${payload.taskGroupId}/${payload.revision}`}
			onError={setRowError}
			onResolved={setResolved}
			payload={payload}
			taskGroupTitle={taskGroups?.find((group) => group.id === payload.taskGroupId)?.title}
		/>
	)
}

function NotebookSummaryRow({
	status,
	changes,
	onOpenTask,
}: {
	status: "applied" | "discarded"
	changes: NotebookChange[]
	onOpenTask: () => void
}) {
	const label =
		status === "applied"
			? `Applied ${changes.length} notebook change${changes.length === 1 ? "" : "s"}`
			: "Discarded notebook changes"
	return (
		<div
			className="flex flex-wrap items-center gap-1.5 rounded-xs border border-editor-group-border bg-code px-2.5 py-1.5 text-xs"
			data-testid="notebook-changes-summary">
			<i aria-hidden className="codicon codicon-book text-(--vscode-charts-purple)" />
			<span>{label}</span>
			{changes.map((change) => (
				<WroteNoteChip key={change.slug} name={change.name} />
			))}
			<span className="flex-1" />
			<LinkButton className="text-[11px]" onClick={onOpenTask}>
				Open task
			</LinkButton>
		</div>
	)
}

function NotebookChangesCard({
	payload,
	taskGroupTitle,
	onResolved,
	onError,
}: {
	payload: NotebookChangesPayload
	taskGroupTitle?: string
	onResolved: (resolved: Pick<NotebookChangesPayload, "status" | "appliedSlugs">) => void
	onError: (error: string | null) => void
}) {
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const apply = async () => {
		setSending(true)
		setError(null)
		onError(null)
		try {
			await TaskGroupServiceClient.applyNotebookChanges(
				ApplyNotebookChangesRequest.create({
					threadId: payload.threadId,
					taskGroupId: payload.taskGroupId,
					revision: payload.revision,
					items: payload.changes.map((change) => ({
						slug: change.slug,
						include: true,
					})),
				}),
			)
			onResolved({
				status: "applied",
				appliedSlugs: payload.changes.map((change) => change.slug),
			})
		} catch (error) {
			const message = `Couldn't apply the changes. ${error instanceof Error ? error.message : "Try again."}`
			setError(message)
			onError(message)
		} finally {
			setSending(false)
		}
	}

	const discard = async () => {
		setSending(true)
		setError(null)
		onError(null)
		try {
			await TaskGroupServiceClient.discardNotebookChanges(
				DiscardNotebookChangesRequest.create({
					threadId: payload.threadId,
					taskGroupId: payload.taskGroupId,
					revision: payload.revision,
				}),
			)
			onResolved({ status: "discarded" })
		} catch (error) {
			const message = `Couldn't discard the changes. ${error instanceof Error ? error.message : "Try again."}`
			setError(message)
			onError(message)
		} finally {
			setSending(false)
		}
	}

	const action = async (slug: string, action: string) => {
		setSending(true)
		setError(null)
		try {
			await TaskGroupServiceClient.notebookAction(
				NotebookActionRequest.create({
					taskGroupId: payload.taskGroupId,
					threadId: payload.threadId,
					revision: payload.revision,
					slug,
					action,
				}),
			)
		} catch (error) {
			setError(error instanceof Error ? error.message : "Couldn't open the note")
		} finally {
			setSending(false)
		}
	}

	return (
		<div>
			<div
				className="rounded-xs border border-editor-group-border bg-code p-2.5 text-xs"
				data-testid="notebook-changes-card">
				<div className="mb-1 flex items-center gap-1.5">
					<i aria-hidden className="codicon codicon-book text-(--vscode-charts-purple)" />
					<span className="flex-1 font-semibold">Notebook changes · {payload.changes.length}</span>
					<span className="text-description">from this thread</span>
				</div>
				{taskGroupTitle && <div className="mb-2 text-description">For {taskGroupTitle}</div>}
				{payload.changes.map((change) => (
					<div className="border-t border-editor-group-border py-2" key={change.slug}>
						<div className="mb-1 flex items-center gap-2">
							<span className="flex-1 font-semibold">{change.name}</span>
							{change.editedByUser && <span className="text-[11px] text-success">edited by you</span>}
							{change.op !== "update" && (
								<span className="text-[11px] text-description">{change.op === "create" ? "new" : "delete"}</span>
							)}
							{change.op !== "delete" && (
								<Button
									aria-label={`Edit ${change.name}`}
									disabled={sending}
									onClick={() => void action(change.slug, "edit")}
									size="xs"
									variant="secondary">
									Edit
								</Button>
							)}
						</div>
						<NotebookDiff lines={change.diff ?? []} />
						{change.draft && (
							<InlineNotice
								actions={
									<>
										<Button
											aria-label={`Retry saving your edit to ${change.name}`}
											disabled={sending}
											onClick={() => void action(change.slug, "retry_draft")}
											size="xs"
											variant="secondary">
											Retry
										</Button>
										<Button
											aria-label={`Reload your draft of ${change.name} in the editor`}
											disabled={sending}
											onClick={() => void action(change.slug, "reload_draft")}
											size="xs"
											variant="secondary">
											Reload
										</Button>
										<Button
											aria-label={`Discard your draft of ${change.name}`}
											disabled={sending}
											onClick={() => void action(change.slug, "discard_draft")}
											size="xs"
											variant="secondary">
											Discard draft
										</Button>
									</>
								}
								className="mt-1"
								data-testid="notebook-draft-notice"
								role="alert"
								tone="warning">
								Your edit wasn't applied: {change.draft.reason}. Your text is kept as a draft.
							</InlineNotice>
						)}
						{change.replacedUserVersion && (
							<div className="mt-1 flex items-center gap-2 text-description">
								agent replaced your edit{" "}
								<Button
									disabled={sending}
									onClick={() => void action(change.slug, "restore_pending")}
									size="xs"
									variant="secondary">
									Restore
								</Button>
							</div>
						)}
					</div>
				))}
				<div className="mt-2 flex justify-end gap-1.5">
					<Button disabled={sending} onClick={() => void discard()} size="xs" variant="secondary">
						Discard all
					</Button>
					<Button disabled={sending} onClick={() => void apply()} size="xs">
						Accept all
					</Button>
				</div>
				{error && (
					<InlineNotice className="mt-2" tone="error">
						{error}
					</InlineNotice>
				)}
			</div>
			<NotebookUserEdits changes={payload.changes} />
		</div>
	)
}

function NotebookUserEdits({ changes }: { changes: NotebookChange[] }) {
	return (
		<>
			{changes
				.filter((change) => change.editedByUser || change.replacedUserVersion)
				.map((change) => (
					<div className="flex items-center gap-1 py-1 text-[11px] text-description" key={change.slug}>
						<span aria-hidden className="codicon codicon-edit text-[11px]!" />
						You edited {change.name}
					</div>
				))}
		</>
	)
}
