import type { ClineMessage } from "@shared/ExtensionMessage"
import { ApplyNotebookChangesRequest, DiscardNotebookChangesRequest, NotebookActionRequest } from "@shared/proto/cline/task_group"
import { ABOUT_YOU_ID, estimateTokens, type NotebookChange, type NotebookChangesPayload } from "@shared/task-groups"
import { useMemo, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { DocEditor } from "@/components/docEditor/DocEditor"
import { MarkedNote } from "@/components/docEditor/MarkedNote"
import { changedSection, diffCounts } from "@/components/docEditor/noteBlocks"
import { NotebookDiff } from "@/components/taskGroup/NotebookDiff"
import { Button } from "@/components/ui/button"
import { type TaskGroupPage, useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskGroupServiceClient } from "@/services/grpc-client"

function parseChanges(raw: unknown): NotebookChange[] | undefined {
	if (!Array.isArray(raw)) return undefined
	return raw.filter(
		(change): change is NotebookChange =>
			!!change && typeof change === "object" && typeof change.slug === "string" && typeof change.name === "string",
	)
}

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
		const appliedSlugs = Array.isArray(parsed.appliedSlugs)
			? parsed.appliedSlugs.filter((slug): slug is string => typeof slug === "string")
			: undefined
		return {
			revision: typeof parsed.revision === "string" ? parsed.revision : "",
			taskGroupId: parsed.taskGroupId,
			threadId: parsed.threadId,
			status,
			changes: parseChanges(parsed.changes) ?? [],
			appliedSlugs,
			turns: typeof parsed.turns === "number" && parsed.turns > 1 ? parsed.turns : undefined,
			kept: parseChanges(parsed.kept),
			dropped: parseChanges(parsed.dropped),
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

/** What a chip says about one change: "new · 5 lines", "+2 −1 in Gotchas", "delete". */
export function changeMeta(change: NotebookChange): string {
	if (change.op === "delete") return "delete"
	const content = change.content ?? ""
	if (change.op === "create") {
		const lines = content.split("\n").filter((line) => line.trim()).length
		return `new · ${lines} ${lines === 1 ? "line" : "lines"}`
	}
	const { added, removed } = diffCounts(change.diff ?? [])
	const counts = [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(" ") || "edited"
	const section = changedSection(content, change.diff ?? [])
	return section ? `${counts} in ${section}` : counts
}

interface NotebookChangesRowProps {
	message: ClineMessage
	/** Opens the task page; defaults to the sidebar task page navigation. */
	onOpenTaskGroup?: (taskGroupId: string, page?: TaskGroupPage) => void
}

/**
 * The review row for notebook (and About you) changes staged in a thread: one
 * row per group, at the end of the newest turn that staged something. A chip
 * per note with its summary; Keep keeps everything in one click; a note opens
 * only on click. Every action applies to the newest staged version, so a click
 * never fails on a stale row.
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
	// Shown right after Keep/Discard succeeds, until the backend rewrites the message status.
	const [resolved, setResolved] = useState<Pick<NotebookChangesPayload, "status" | "kept" | "dropped"> | null>(null)

	if (!payload) return null
	const aboutYou = payload.taskGroupId === ABOUT_YOU_ID
	const status = payload.status === "pending" ? (resolved?.status ?? payload.status) : payload.status
	if (status !== "pending") {
		const settled = payload.status === "pending" && resolved ? { ...payload, ...resolved } : payload
		const kept =
			settled.kept ??
			(status === "applied"
				? settled.appliedSlugs
					? settled.changes.filter((change) => settled.appliedSlugs?.includes(change.slug))
					: settled.changes
				: [])
		return (
			<div>
				<NotebookSummaryRow
					aboutYou={aboutYou}
					dropped={settled.dropped ?? (status === "discarded" ? settled.changes : [])}
					kept={kept}
					onOpen={() => openTaskGroup?.(payload.taskGroupId, aboutYou ? "notebook" : undefined)}
				/>
				<NotebookUserEdits changes={payload.changes} />
			</div>
		)
	}
	if (!isNewest || payload.changes.length === 0) {
		// Only older histories have these: a newer turn's row now carries the changes.
		return (
			<div className="flex items-center gap-1.5 text-xs text-description" data-testid="notebook-changes-superseded">
				<i aria-hidden className="codicon codicon-book" />
				<span>Note changes moved to a later turn</span>
			</div>
		)
	}
	return (
		<NotebookReviewRow
			aboutYou={aboutYou}
			key={payload.taskGroupId}
			onResolved={setResolved}
			payload={payload}
			taskGroupTitle={taskGroups?.find((group) => group.id === payload.taskGroupId)?.title}
		/>
	)
}

function NotebookSummaryRow({
	kept,
	dropped,
	aboutYou,
	onOpen,
}: {
	kept: NotebookChange[]
	dropped: NotebookChange[]
	aboutYou: boolean
	onOpen: () => void
}) {
	const noun = aboutYou ? "About you change" : "note change"
	const label = kept.length
		? `Kept ${kept.length} ${noun}${kept.length === 1 ? "" : "s"}`
		: `Dropped ${aboutYou ? "About you changes" : "note changes"}`
	return (
		<div
			className="flex flex-wrap items-center gap-1.5 rounded-xs border border-editor-group-border bg-code px-2.5 py-1.5 text-xs"
			data-testid="notebook-changes-summary">
			<i
				aria-hidden
				className={cn("codicon text-(--vscode-charts-purple)", aboutYou ? "codicon-account" : "codicon-book")}
			/>
			<span>{label}</span>
			{kept.map((change) => (
				<WroteNoteChip key={change.slug} name={change.name} />
			))}
			{kept.length > 0 && dropped.length > 0 && <span className="text-description">· dropped {dropped.length}</span>}
			<span className="flex-1" />
			<LinkButton className="text-[11px]" onClick={onOpen}>
				{aboutYou ? "Open About you" : "Open task"}
			</LinkButton>
		</div>
	)
}

function NotebookReviewRow({
	payload,
	taskGroupTitle,
	aboutYou,
	onResolved,
}: {
	payload: NotebookChangesPayload
	taskGroupTitle?: string
	aboutYou: boolean
	onResolved: (resolved: Pick<NotebookChangesPayload, "status" | "kept" | "dropped">) => void
}) {
	const [open, setOpen] = useState<string>()
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const opened = payload.changes.find((change) => change.slug === open)
	const address = { threadId: payload.threadId, taskGroupId: payload.taskGroupId, revision: payload.revision }

	const run = async (operation: () => Promise<unknown>, failure: string) => {
		setSending(true)
		setError(null)
		try {
			await operation()
		} catch (error) {
			setError(`${failure} ${error instanceof Error ? error.message : "Try again."}`)
		} finally {
			setSending(false)
		}
	}

	const keep = (slugs: string[]) =>
		run(async () => {
			await TaskGroupServiceClient.applyNotebookChanges(
				ApplyNotebookChangesRequest.create({ ...address, items: slugs.map((slug) => ({ slug, include: true })) }),
			)
			if (slugs.length === payload.changes.length)
				onResolved({
					status: "applied",
					kept: [...(payload.kept ?? []), ...payload.changes],
					dropped: payload.dropped,
				})
			setOpen(undefined)
		}, "Couldn't keep the changes.")

	const drop = (slugs: string[]) =>
		run(async () => {
			await TaskGroupServiceClient.discardNotebookChanges(
				DiscardNotebookChangesRequest.create({ ...address, slugs: slugs.length === payload.changes.length ? [] : slugs }),
			)
			if (slugs.length === payload.changes.length) {
				const kept = payload.kept ?? []
				onResolved({
					status: kept.length ? "applied" : "discarded",
					kept,
					dropped: [...(payload.dropped ?? []), ...payload.changes],
				})
			}
			setOpen(undefined)
		}, "Couldn't drop the changes.")

	const action = (slug: string, action: string, extra: Partial<NotebookActionRequest> = {}) =>
		run(
			() => TaskGroupServiceClient.notebookAction(NotebookActionRequest.create({ ...address, slug, action, ...extra })),
			"Couldn't update the note.",
		)

	const count = payload.changes.length
	const noun = aboutYou ? "About you change" : "note change"
	const when = payload.turns ? `last ${payload.turns} turns` : "this turn"
	const all = payload.changes.map((change) => change.slug)
	const answered = [
		...(payload.kept ?? []).map((c) => `kept ${c.name}`),
		...(payload.dropped ?? []).map((c) => `dropped ${c.name}`),
	]

	return (
		<div>
			<div
				className="rounded-xs border border-editor-group-border bg-code px-2.5 py-2 text-xs"
				data-testid="notebook-changes-card">
				<div className="flex flex-wrap items-center gap-1.5">
					<i
						aria-hidden
						className={cn("codicon text-(--vscode-charts-purple)", aboutYou ? "codicon-account" : "codicon-book")}
					/>
					<span className="min-w-0 flex-1 truncate">
						<span className="font-semibold">
							{count} {noun}
							{count === 1 ? "" : "s"}
						</span>
						<span className="text-description">
							{" "}
							· {when}
							{aboutYou ? " · every thread" : taskGroupTitle ? ` · ${taskGroupTitle}` : ""}
						</span>
					</span>
					<Button disabled={sending} onClick={() => void drop(all)} size="xs" variant="secondary">
						Discard
					</Button>
					<Button disabled={sending} onClick={() => void keep(all)} size="xs">
						Keep
					</Button>
				</div>
				<div className="mt-1.5 flex flex-wrap gap-1">
					{payload.changes.map((change) => (
						<button
							aria-expanded={open === change.slug}
							className={cn(
								"inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-xs border border-solid px-1.5 py-0.5 text-left font-[inherit] text-[11px] leading-4 text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
								open === change.slug
									? "border-(--vscode-focusBorder) bg-[color-mix(in_srgb,var(--vscode-charts-purple)_22%,transparent)]"
									: "border-[color-mix(in_srgb,var(--vscode-charts-purple)_45%,transparent)] bg-[color-mix(in_srgb,var(--vscode-charts-purple)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--vscode-charts-purple)_22%,transparent)]",
							)}
							key={change.slug}
							onClick={() => setOpen((current) => (current === change.slug ? undefined : change.slug))}
							title={change.summary ?? `Open ${change.name}`}
							type="button">
							<i
								aria-hidden
								className={cn("codicon text-[10px]!", change.op === "delete" ? "codicon-trash" : "codicon-edit")}
							/>
							<span className="truncate font-medium">{change.name}</span>
							<span className="shrink-0 text-description">{changeMeta(change)}</span>
							{change.editedByUser && <span className="shrink-0 text-success">· edited by you</span>}
						</button>
					))}
				</div>
				{answered.length > 0 && <div className="mt-1 text-[11px] text-description">Already {answered.join(", ")}</div>}
				{opened && (
					<OpenedChange
						aboutYou={aboutYou}
						change={opened}
						key={opened.slug}
						onAction={(name, extra) => void action(opened.slug, name, extra)}
						onDrop={() => void drop([opened.slug])}
						onKeep={() => void keep([opened.slug])}
						sending={sending}
					/>
				)}
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

function OpenedChange({
	change,
	aboutYou,
	sending,
	onKeep,
	onDrop,
	onAction,
}: {
	change: NotebookChange
	aboutYou: boolean
	sending: boolean
	onKeep: () => void
	onDrop: () => void
	onAction: (action: string, extra?: Partial<NotebookActionRequest>) => void
}) {
	const [asDiff, setAsDiff] = useState(false)
	const [editing, setEditing] = useState(false)
	const content = change.content ?? ""
	return (
		<div className="mt-2 border-0 border-t border-solid border-editor-group-border pt-2" data-testid="notebook-opened-change">
			{change.summary && <p className="m-0 mb-1.5 italic text-description">“{change.summary}”</p>}
			{editing ? (
				<DocEditor
					initialMode="edit"
					label={`${change.name} body`}
					onSave={async (body) => {
						onAction("save_pending", { content: body, baseContent: content })
						setEditing(false)
					}}
					status={aboutYou ? <span>≈ {estimateTokens(content)} tokens · every thread</span> : undefined}
					value={content}
				/>
			) : change.op === "delete" ? (
				<p className="m-0 text-description">Deletes this note. History keeps its last version.</p>
			) : asDiff ? (
				<NotebookDiff lines={change.diff ?? []} />
			) : (
				<div className="rounded-xs bg-(--vscode-editor-background) px-1 py-1">
					<MarkedNote content={content} diff={change.op === "create" ? [] : (change.diff ?? [])} />
				</div>
			)}
			{change.draft && (
				<InlineNotice
					actions={
						<>
							<Button
								aria-label={`Retry saving your edit to ${change.name}`}
								disabled={sending}
								onClick={() => onAction("retry_draft")}
								size="xs"
								variant="secondary">
								Retry
							</Button>
							<Button
								aria-label={`Reload your draft of ${change.name} in the editor`}
								disabled={sending}
								onClick={() => onAction("reload_draft")}
								size="xs"
								variant="secondary">
								Reload
							</Button>
							<Button
								aria-label={`Discard your draft of ${change.name}`}
								disabled={sending}
								onClick={() => onAction("discard_draft")}
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
					<Button disabled={sending} onClick={() => onAction("restore_pending")} size="xs" variant="secondary">
						Restore
					</Button>
				</div>
			)}
			{!editing && (
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					<Button aria-label={`Keep ${change.name}`} disabled={sending} onClick={onKeep} size="xs">
						Keep this one
					</Button>
					<Button aria-label={`Drop ${change.name}`} disabled={sending} onClick={onDrop} size="xs" variant="secondary">
						Drop
					</Button>
					{change.op !== "delete" && (
						<Button
							aria-label={`Edit ${change.name}`}
							disabled={sending}
							onClick={() => setEditing(true)}
							size="xs"
							variant="secondary">
							Edit
						</Button>
					)}
					<span className="flex-1" />
					{change.op === "update" && (
						<LinkButton className="text-[11px]" onClick={() => setAsDiff((value) => !value)}>
							{asDiff ? "Show as note" : "Show as diff"}
						</LinkButton>
					)}
					{aboutYou && change.op !== "delete" && (
						<span className="text-[11px] text-description">≈ {estimateTokens(content)} tokens · every thread</span>
					)}
				</div>
			)}
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
