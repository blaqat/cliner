import type { ClineMessage } from "@shared/ExtensionMessage"
import { ApplyNotebookChangesRequest, DiscardNotebookChangesRequest } from "@shared/proto/cline/task_group"
import type { NotebookChange, NotebookChangeOp, NotebookChangesPayload } from "@shared/task-groups"
import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
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
		return { taskGroupId: parsed.taskGroupId, threadId: parsed.threadId, status, changes, appliedSlugs }
	} catch {
		return null
	}
}

const OP_BADGE: Record<NotebookChangeOp, { label: string; className: string }> = {
	create: { label: "new", className: "text-success border-success/40 bg-success/10" },
	update: { label: "edit", className: "text-link border-link/40 bg-link/10" },
	delete: { label: "delete", className: "text-error border-error/40 bg-error/10" },
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
 * card in the thread is interactive; older pending ones collapse to a
 * "superseded" line, and resolved ones to a one-line summary.
 */
export function NotebookChangesRow({ message, onOpenTaskGroup }: NotebookChangesRowProps) {
	const { clineMessages, navigateToTaskGroup } = useExtensionState()
	const openTaskGroup = onOpenTaskGroup ?? navigateToTaskGroup
	const payload = useMemo(() => parseNotebookChangesPayload(message.text), [message.text])
	const isNewest = useMemo(() => {
		for (let i = clineMessages.length - 1; i >= 0; i--) {
			if (clineMessages[i].say === "notebook_changes") return clineMessages[i].ts === message.ts
		}
		return true
	}, [clineMessages, message.ts])
	// Shown right after Apply/Discard succeeds, until the backend rewrites the message status.
	const [resolved, setResolved] = useState<Pick<NotebookChangesPayload, "status" | "appliedSlugs"> | null>(null)

	if (!payload) return null
	const status = resolved?.status ?? payload.status
	if (status !== "pending") {
		const appliedSlugs = resolved?.appliedSlugs ?? payload.appliedSlugs
		return (
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
		)
	}
	if (!isNewest || payload.changes.length === 0) {
		return (
			<div className="flex items-center gap-1.5 text-xs text-description" data-testid="notebook-changes-superseded">
				<i aria-hidden className="codicon codicon-book" />
				<span>Notebook changes superseded by a later review</span>
			</div>
		)
	}
	return <NotebookChangesCard onResolved={setResolved} payload={payload} />
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
			<i aria-hidden className="codicon codicon-book text-[var(--vscode-charts-purple)]" />
			<span>{label}</span>
			{changes.map((change) => (
				<WroteNoteChip key={change.slug} name={change.name} />
			))}
			<span className="flex-1" />
			<button
				className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
				onClick={onOpenTask}
				type="button">
				Open task
			</button>
		</div>
	)
}

function NotebookChangesCard({
	payload,
	onResolved,
}: {
	payload: NotebookChangesPayload
	onResolved: (resolved: Pick<NotebookChangesPayload, "status" | "appliedSlugs">) => void
}) {
	const [included, setIncluded] = useState<Record<string, boolean>>(() =>
		Object.fromEntries(payload.changes.map((change) => [change.slug, true])),
	)
	const [edited, setEdited] = useState<Record<string, string>>({})
	const [editing, setEditing] = useState<string | null>(null)
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const count = payload.changes.filter((change) => included[change.slug]).length

	const apply = async () => {
		setSending(true)
		setError(null)
		try {
			await TaskGroupServiceClient.applyNotebookChanges(
				ApplyNotebookChangesRequest.create({
					threadId: payload.threadId,
					items: payload.changes.map((change) => ({
						slug: change.slug,
						include: !!included[change.slug],
						editedContent:
							edited[change.slug] !== undefined && edited[change.slug] !== (change.content ?? "")
								? edited[change.slug]
								: undefined,
					})),
				}),
			)
			onResolved({
				status: "applied",
				appliedSlugs: payload.changes.filter((change) => included[change.slug]).map((change) => change.slug),
			})
		} catch {
			setError("Couldn't apply the changes. Try again.")
		} finally {
			setSending(false)
		}
	}

	const discard = async () => {
		setSending(true)
		setError(null)
		try {
			await TaskGroupServiceClient.discardNotebookChanges(
				DiscardNotebookChangesRequest.create({ threadId: payload.threadId }),
			)
			onResolved({ status: "discarded" })
		} catch {
			setError("Couldn't discard the changes. Try again.")
		} finally {
			setSending(false)
		}
	}

	return (
		<div
			className="rounded-xs border border-[color-mix(in_srgb,var(--vscode-charts-purple)_45%,var(--vscode-editorGroup-border))] bg-code p-2.5 text-xs"
			data-testid="notebook-changes-card">
			<div className="mb-1 flex items-center gap-1.5">
				<i aria-hidden className="codicon codicon-book text-[var(--vscode-charts-purple)]" />
				<span className="flex-1 font-semibold">Notebook changes · {payload.changes.length}</span>
			</div>
			<div className="mb-1 text-[11px] text-description">
				Staged while the thread ran. Nothing is written until you apply.
			</div>
			{payload.changes.map((change) => {
				const badge = OP_BADGE[change.op] ?? OP_BADGE.update
				const isEditing = editing === change.slug
				const checkboxId = `notebook-change-${change.slug}`
				return (
					<div className="border-t border-editor-group-border py-1.5" key={change.slug}>
						<div className="flex min-w-0 items-center gap-2">
							<input
								checked={!!included[change.slug]}
								className="m-0 shrink-0 cursor-pointer accent-[var(--vscode-button-background)]"
								disabled={sending}
								id={checkboxId}
								onChange={(event) => setIncluded((prev) => ({ ...prev, [change.slug]: event.target.checked }))}
								type="checkbox"
							/>
							<label className="min-w-0 flex-1 cursor-pointer truncate font-semibold" htmlFor={checkboxId}>
								{change.name}
							</label>
							<span className={cn("shrink-0 rounded-xs border px-1 text-[10.5px] leading-4", badge.className)}>
								{badge.label}
							</span>
							{change.op !== "delete" && (
								<button
									aria-label={`${isEditing ? "Done editing" : "Edit"} ${change.name}`}
									aria-pressed={isEditing}
									className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline disabled:opacity-50"
									disabled={sending}
									onClick={() => setEditing(isEditing ? null : change.slug)}
									type="button">
									{isEditing ? "Done" : "Edit"}
								</button>
							)}
						</div>
						{isEditing ? (
							<textarea
								aria-label={`Content of ${change.name}`}
								className="mt-1.5 ml-5 box-border block min-h-24 w-[calc(100%-1.25rem)] resize-y rounded-xs border border-input-border bg-input-background p-1.5 font-mono text-[11px] leading-[1.55] text-input-foreground focus:border-border focus:outline-none"
								disabled={sending}
								onChange={(event) => setEdited((prev) => ({ ...prev, [change.slug]: event.target.value }))}
								value={edited[change.slug] ?? change.content ?? ""}
							/>
						) : (
							change.description && (
								<div className="ml-5 truncate text-[11px] text-description">{change.description}</div>
							)
						)}
					</div>
				)
			})}
			<div className="mt-2 flex flex-wrap items-center gap-1.5">
				<Button className="px-2.5" disabled={sending || count === 0} onClick={() => void apply()} size="xs" type="button">
					Apply {count}
				</Button>
				<Button
					className="px-2.5"
					disabled={sending}
					onClick={() => void discard()}
					size="xs"
					type="button"
					variant="secondary">
					Discard all
				</Button>
				{error && (
					<span className="text-[11px] text-error" role="alert">
						{error}
					</span>
				)}
			</div>
		</div>
	)
}
