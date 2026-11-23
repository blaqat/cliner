import type { ClineMessage } from "@shared/ExtensionMessage"
import { ApplyNotebookChangesRequest, DiscardNotebookChangesRequest, NotebookActionRequest } from "@shared/proto/cline/task_group"
import { SKILL_DRAFTS_ID } from "@shared/skillsets"
import { ABOUT_YOU_ID, estimateTokens, type NotebookChange, type NotebookChangesPayload } from "@shared/task-groups"
import { useMemo, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { DocEditor } from "@/components/docEditor/DocEditor"
import { MarkedNote } from "@/components/docEditor/MarkedNote"
import { changedSection, diffCounts } from "@/components/docEditor/noteBlocks"
import { OpenedSkillDraft } from "@/components/skills/OpenedSkillDraft"
import { openSkills } from "@/components/skills/skillsetStore"
import { NotebookDiff, PROPOSAL_BODY_CLASS } from "@/components/taskGroup/NotebookDiff"
import { Button } from "@/components/ui/button"
import { type TaskGroupPage, useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskGroupServiceClient } from "@/services/grpc-client"
import { notebookTurnRun } from "./notebookTurnRows"

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
			autoKept: typeof parsed.autoKept === "number" ? parsed.autoKept : undefined,
		}
	} catch {
		return null
	}
}

/** A note this thread wrote: solid purple chip with a pencil, matching the task page timeline. */
export function WroteNoteChip({ name, icon = "edit" }: { name: string; icon?: string }) {
	return (
		<span className="inline-flex max-w-40 min-w-0 items-center gap-1 rounded-xs border border-[color-mix(in_srgb,var(--vscode-charts-purple)_45%,transparent)] bg-[color-mix(in_srgb,var(--vscode-charts-purple)_15%,transparent)] px-1.5 text-[11px] leading-4">
			<i aria-hidden className={`codicon codicon-${icon} text-[10px]!`} />
			<span className="truncate">{name}</span>
		</span>
	)
}

/** What a chip says about one change: "new · 5 lines", "+2 −1 in Gotchas", "delete", "new skill · 2 files". */
export function changeMeta(change: NotebookChange): string {
	if (change.op === "delete") return "delete"
	const content = change.content ?? ""
	if (change.op === "create") {
		if (change.skill) {
			const files = 1 + (change.skill.kind === "skill" ? (change.skill.files?.length ?? 0) : 0)
			return `new ${change.skill.kind}${files > 1 ? ` · ${files} files` : ""}`
		}
		const lines = content.split("\n").filter((line) => line.trim()).length
		return `new · ${lines} ${lines === 1 ? "line" : "lines"}`
	}
	const { added, removed } = diffCounts(change.diff ?? [])
	const counts = [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(" ") || "edited"
	const section = changedSection(content, change.diff ?? [])
	return section ? `${counts} in ${section}` : counts
}

type ReviewKind = "notes" | "about" | "skills"

function kindOf(groupId: string): ReviewKind {
	return groupId === ABOUT_YOU_ID ? "about" : groupId === SKILL_DRAFTS_ID ? "skills" : "notes"
}

/** The chip's icon: a note's pencil, About you's person, a skill's sparkle, a workflow's list. */
function changeIcon(kind: ReviewKind, change: NotebookChange): string {
	if (change.op === "delete") return "trash"
	if (kind === "about") return "account"
	if (kind === "skills") return change.skill?.kind === "workflow" ? "list-ordered" : "sparkle"
	return "edit"
}

/** Kept workflows open in the Workflows tab; anything with a skill opens Skills. */
function draftsTab(changes: NotebookChange[]): "skills" | "workflows" {
	return changes.length && changes.every((change) => change.skill?.kind === "workflow") ? "workflows" : "skills"
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** "2 note changes, 1 About you change, 1 skill": counts by kind, in a fixed order. */
export function countPhrase(entries: { kind: ReviewKind; change: NotebookChange }[]): string {
	const notes = entries.filter((entry) => entry.kind === "notes").length
	const about = entries.filter((entry) => entry.kind === "about").length
	const skills = entries.filter((entry) => entry.kind === "skills" && entry.change.skill?.kind !== "workflow").length
	const workflows = entries.filter((entry) => entry.kind === "skills" && entry.change.skill?.kind === "workflow").length
	const instructions = [skills && plural(skills, "skill"), workflows && plural(workflows, "workflow")]
		.filter(Boolean)
		.join(" and ")
	return [notes && plural(notes, "note change"), about && plural(about, "About you change"), instructions]
		.filter(Boolean)
		.join(", ")
}

interface NotebookChangesRowProps {
	message: ClineMessage
	/** Opens the task page; defaults to the sidebar task page navigation. */
	onOpenTaskGroup?: (taskGroupId: string, page?: TaskGroupPage) => void
}

type Resolved = Pick<NotebookChangesPayload, "status" | "kept" | "dropped">

/**
 * The review row at the end of a turn that staged changes: task notes, About
 * you and skills together, one row per turn. A chip per change with the
 * agent's summary; Keep keeps everything in one click; a change opens only on
 * click. Every action applies to the newest staged version, so a click never
 * fails on a stale row.
 */
export function NotebookChangesRow({ message, onOpenTaskGroup }: NotebookChangesRowProps) {
	const { clineMessages } = useExtensionState()
	// The other kinds this turn staged ride along in this row (they render nothing themselves).
	const members = useMemo(() => {
		const index = clineMessages.findIndex((entry) => entry.ts === message.ts && entry.say === "notebook_changes")
		const run = index >= 0 ? notebookTurnRun(clineMessages, index) : []
		if (!run.length) return [message]
		if (run[0].ts !== message.ts) return []
		// The row renders from the message it was given (freshest), the rest from state.
		return run.map((entry) => (entry.ts === message.ts ? message : entry))
	}, [clineMessages, message])
	const payloads = useMemo(
		() =>
			members
				.map((member) => ({ message: member, payload: parseNotebookChangesPayload(member.text) }))
				.filter((entry): entry is { message: ClineMessage; payload: NotebookChangesPayload } => !!entry.payload),
		[members],
	)
	if (!payloads.length) return null
	return <TurnReview entries={payloads} onOpenTaskGroup={onOpenTaskGroup} />
}

function TurnReview({
	entries,
	onOpenTaskGroup,
}: {
	entries: { message: ClineMessage; payload: NotebookChangesPayload }[]
	onOpenTaskGroup?: (taskGroupId: string, page?: TaskGroupPage) => void
}) {
	const { clineMessages, navigateToTaskGroup, taskGroups, workspaceRoots } = useExtensionState()
	const openTaskGroup = onOpenTaskGroup ?? navigateToTaskGroup
	// Shown right after Keep/Discard succeeds, until the backend rewrites the message status.
	const [resolved, setResolved] = useState<Record<string, Resolved>>({})

	const groups = entries.map(({ message, payload }) => {
		let isNewest = true
		for (let i = clineMessages.length - 1; i >= 0; i--) {
			if (clineMessages[i].say !== "notebook_changes") continue
			const candidate = parseNotebookChangesPayload(clineMessages[i].text)
			if (candidate?.taskGroupId === payload.taskGroupId && candidate?.threadId === payload.threadId) {
				isNewest = clineMessages[i].ts === message.ts
				break
			}
		}
		const local = resolved[payload.taskGroupId]
		const status = payload.status === "pending" ? (local?.status ?? payload.status) : payload.status
		const settled = payload.status === "pending" && local ? { ...payload, ...local } : payload
		return { payload, settled, status, isNewest, kind: kindOf(payload.taskGroupId) }
	})

	const pending = groups.filter((group) => group.status === "pending" && group.isNewest && group.payload.changes.length)
	const settledGroups = groups.filter((group) => group.status !== "pending")
	const superseded = groups.filter((group) => group.status === "pending" && (!group.isNewest || !group.payload.changes.length))

	const summary = settledGroups.length > 0 && (
		<TurnSummary
			groups={settledGroups.map((group) => ({ ...group, payload: group.settled }))}
			onOpen={(group, tab) => {
				if (group.kind === "skills") openSkills({ tab })
				else
					openTaskGroup?.(
						group.payload.taskGroupId,
						group.kind === "about" || group.payload.autoKept ? "notebook" : undefined,
					)
			}}
		/>
	)
	const allChanges = groups.flatMap((group) => group.payload.changes)

	return (
		<div className="flex flex-col gap-1">
			{pending.length > 0 && (
				<ReviewCard
					groups={pending.map((group) => group.payload)}
					hasWorkspace={(workspaceRoots?.length ?? 0) > 0}
					onResolved={(groupId, value) => setResolved((current) => ({ ...current, [groupId]: value }))}
					taskGroupTitle={(groupId) => taskGroups?.find((group) => group.id === groupId)?.title}
				/>
			)}
			{summary}
			{!pending.length && superseded.length > 0 && (
				// Only older histories have these: a newer turn's row now carries the changes.
				<div className="flex items-center gap-1.5 text-xs text-description" data-testid="notebook-changes-superseded">
					<i aria-hidden className="codicon codicon-book" />
					<span>Note changes moved to a later turn</span>
				</div>
			)}
			<NotebookUserEdits changes={allChanges} />
		</div>
	)
}

function TurnSummary({
	groups,
	onOpen,
}: {
	groups: { payload: NotebookChangesPayload; status: string; kind: ReviewKind }[]
	onOpen: (group: { payload: NotebookChangesPayload; kind: ReviewKind }, tab: "skills" | "workflows") => void
}) {
	const keptOf = (group: { payload: NotebookChangesPayload; status: string }) =>
		group.payload.kept ??
		(group.status === "applied"
			? group.payload.appliedSlugs
				? group.payload.changes.filter((change) => group.payload.appliedSlugs?.includes(change.slug))
				: group.payload.changes
			: [])
	const droppedOf = (group: { payload: NotebookChangesPayload; status: string }) =>
		group.payload.dropped ?? (group.status === "discarded" ? group.payload.changes : [])
	const kept = groups.flatMap((group) => keptOf(group).map((change) => ({ kind: group.kind, change })))
	const dropped = groups.flatMap((group) => droppedOf(group).map((change) => ({ kind: group.kind, change })))
	const only = groups.length === 1 ? groups[0].kind : undefined
	const autoKept = groups.reduce((count, group) => count + (group.payload.autoKept ?? 0), 0)
	const label = kept.length
		? `Kept ${countPhrase(kept)}`
		: only === "about"
			? "Dropped About you changes"
			: only === "skills"
				? `Dropped ${countPhrase(dropped)}`
				: only === "notes"
					? "Dropped note changes"
					: "Dropped the changes"
	const links = groups
		.filter((group) => keptOf(group).length || groups.length === 1)
		.map((group) => ({ group, tab: draftsTab(keptOf(group).length ? keptOf(group) : droppedOf(group)) }))
	return (
		<div
			className="flex flex-wrap items-center gap-1.5 rounded-xs border border-editor-group-border bg-code px-2.5 py-1.5 text-xs"
			data-testid="notebook-changes-summary">
			<i
				aria-hidden
				className={cn("codicon", kept.length ? "codicon-pass text-success" : "codicon-circle-slash text-description")}
			/>
			<span>{label}</span>
			{autoKept > 0 && (
				<span className="text-description">
					{autoKept === kept.length ? "automatically" : `· ${autoKept} automatically`}
				</span>
			)}
			{kept.map(({ kind, change }) => (
				<WroteNoteChip
					icon={changeIcon(kind, { ...change, op: "update" })}
					key={`${kind}:${change.slug}`}
					name={change.name}
				/>
			))}
			{kept.length > 0 && dropped.length > 0 && <span className="text-description">· dropped {dropped.length}</span>}
			<span className="flex-1" />
			{links.map(({ group, tab }) => (
				<LinkButton className="text-[11px]" key={group.payload.taskGroupId} onClick={() => onOpen(group, tab)}>
					{group.kind === "about"
						? "Open About you"
						: group.kind === "skills"
							? `Open in ${tab === "workflows" ? "Workflows" : "Skills"}`
							: group.payload.autoKept
								? "Notebook and history"
								: "Open task"}
				</LinkButton>
			))}
		</div>
	)
}

function ReviewCard({
	groups,
	taskGroupTitle,
	hasWorkspace,
	onResolved,
}: {
	groups: NotebookChangesPayload[]
	taskGroupTitle: (groupId: string) => string | undefined
	hasWorkspace: boolean
	onResolved: (groupId: string, resolved: Resolved) => void
}) {
	const [open, setOpen] = useState<string>()
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const entries = groups.flatMap((payload) =>
		payload.changes.map((change) => ({
			payload,
			change,
			kind: kindOf(payload.taskGroupId),
			key: `${payload.taskGroupId}:${change.slug}`,
		})),
	)
	const opened = entries.find((entry) => entry.key === open)
	const address = (payload: NotebookChangesPayload) => ({
		threadId: payload.threadId,
		taskGroupId: payload.taskGroupId,
		revision: payload.revision,
	})

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

	const keepIn = async (payload: NotebookChangesPayload, slugs: string[]) => {
		await TaskGroupServiceClient.applyNotebookChanges(
			ApplyNotebookChangesRequest.create({ ...address(payload), items: slugs.map((slug) => ({ slug, include: true })) }),
		)
		if (slugs.length === payload.changes.length)
			onResolved(payload.taskGroupId, {
				status: "applied",
				kept: [...(payload.kept ?? []), ...payload.changes],
				dropped: payload.dropped,
			})
	}
	const dropIn = async (payload: NotebookChangesPayload, slugs: string[]) => {
		await TaskGroupServiceClient.discardNotebookChanges(
			DiscardNotebookChangesRequest.create({
				...address(payload),
				slugs,
			}),
		)
		if (slugs.length === payload.changes.length) {
			const kept = payload.kept ?? []
			onResolved(payload.taskGroupId, {
				status: kept.length ? "applied" : "discarded",
				kept,
				dropped: [...(payload.dropped ?? []), ...payload.changes],
			})
		}
	}

	const keepAll = () =>
		run(async () => {
			for (const payload of groups)
				await keepIn(
					payload,
					payload.changes.map((change) => change.slug),
				)
			setOpen(undefined)
		}, "Couldn't keep the changes.")
	const dropAll = () =>
		run(async () => {
			for (const payload of groups)
				await dropIn(
					payload,
					payload.changes.map((change) => change.slug),
				)
			setOpen(undefined)
		}, "Couldn't drop the changes.")
	const keepOne = (payload: NotebookChangesPayload, slug: string) =>
		run(async () => {
			await keepIn(payload, [slug])
			setOpen(undefined)
		}, "Couldn't keep it.")
	const dropOne = (payload: NotebookChangesPayload, slug: string) =>
		run(async () => {
			await dropIn(payload, [slug])
			setOpen(undefined)
		}, "Couldn't drop it.")
	const action = (payload: NotebookChangesPayload, slug: string, name: string, extra: Partial<NotebookActionRequest> = {}) =>
		run(
			() =>
				TaskGroupServiceClient.notebookAction(
					NotebookActionRequest.create({ ...address(payload), slug, action: name, ...extra }),
				),
			"Couldn't update it.",
		)

	const turns = Math.max(...groups.map((payload) => payload.turns ?? 1))
	const when = turns > 1 ? `last ${turns} turns` : "this turn"
	const notesGroup = groups.find((payload) => kindOf(payload.taskGroupId) === "notes")
	const where = notesGroup
		? taskGroupTitle(notesGroup.taskGroupId)
		: groups.length === 1 && kindOf(groups[0].taskGroupId) === "about"
			? "every thread"
			: undefined
	const many = entries.length > 1
	const answered = groups.flatMap((payload) => [
		...(payload.kept ?? []).map((change) => `kept ${change.name}`),
		...(payload.dropped ?? []).map((change) => `dropped ${change.name}`),
	])
	const headIcon =
		groups.length > 1
			? "checklist"
			: kindOf(groups[0].taskGroupId) === "about"
				? "account"
				: kindOf(groups[0].taskGroupId) === "skills"
					? "sparkle"
					: "book"

	return (
		<div
			className="rounded-xs border border-editor-group-border bg-code px-2.5 py-2 text-xs"
			data-testid="notebook-changes-card">
			<div className="flex flex-wrap items-center gap-1.5">
				<i aria-hidden className={`codicon codicon-${headIcon} text-(--vscode-charts-purple)`} />
				<span className="min-w-0 flex-1 truncate">
					<span className="font-semibold">{countPhrase(entries)}</span>
					<span className="text-description">
						{" "}
						· {when}
						{where ? ` · ${where}` : ""}
					</span>
				</span>
				<Button disabled={sending} onClick={() => void dropAll()} size="xs" variant="secondary">
					{many ? "Discard all" : "Discard"}
				</Button>
				<Button disabled={sending} onClick={() => void keepAll()} size="xs">
					{many ? "Keep all" : "Keep"}
				</Button>
			</div>
			<div className="mt-1.5 flex flex-wrap gap-1">
				{entries.map(({ change, kind, key }) => (
					<button
						aria-expanded={open === key}
						className={cn(
							"inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-xs border border-solid px-1.5 py-0.5 text-left font-[inherit] text-[11px] leading-4 text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
							open === key
								? "border-(--vscode-focusBorder) bg-[color-mix(in_srgb,var(--vscode-charts-purple)_22%,transparent)]"
								: "border-[color-mix(in_srgb,var(--vscode-charts-purple)_45%,transparent)] bg-[color-mix(in_srgb,var(--vscode-charts-purple)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--vscode-charts-purple)_22%,transparent)]",
						)}
						key={key}
						onClick={() => setOpen((current) => (current === key ? undefined : key))}
						title={change.summary ?? `Open ${change.name}`}
						type="button">
						<i
							aria-hidden
							className={cn(
								`codicon codicon-${changeIcon(kind, change)} text-[10px]!`,
								kind === "skills" && change.op !== "delete" && "text-(--vscode-charts-yellow)",
							)}
						/>
						<span className="truncate font-medium">{change.name}</span>
						<span className="shrink-0 text-description">{changeMeta(change)}</span>
						{change.skill?.conflict && (
							<span className="shrink-0 text-(--vscode-editorWarning-foreground)">· changed on disk</span>
						)}
						{change.editedByUser && <span className="shrink-0 text-success">· edited by you</span>}
					</button>
				))}
			</div>
			{!opened && entries.length === 1 && entries[0].change.summary && (
				<p className="m-0 mt-1.5 truncate text-[11px] italic text-description" title={entries[0].change.summary}>
					“{entries[0].change.summary}”
				</p>
			)}
			{answered.length > 0 && <div className="mt-1 text-[11px] text-description">Already {answered.join(", ")}</div>}
			{opened &&
				(opened.kind === "skills" ? (
					<OpenedSkillDraft
						change={opened.change}
						hasWorkspace={hasWorkspace}
						key={opened.key}
						onAction={(name, extra) => void action(opened.payload, opened.change.slug, name, extra)}
						onDrop={() => void dropOne(opened.payload, opened.change.slug)}
						onKeep={() => void keepOne(opened.payload, opened.change.slug)}
						sending={sending}
					/>
				) : (
					<OpenedChange
						aboutYou={opened.kind === "about"}
						change={opened.change}
						key={opened.key}
						onAction={(name, extra) => void action(opened.payload, opened.change.slug, name, extra)}
						onDrop={() => void dropOne(opened.payload, opened.change.slug)}
						onKeep={() => void keepOne(opened.payload, opened.change.slug)}
						sending={sending}
					/>
				))}
			{error && (
				<InlineNotice className="mt-2" tone="error">
					{error}
				</InlineNotice>
			)}
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
	// An update opens on what changed; the whole note is one click away.
	const [whole, setWhole] = useState(false)
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
			) : (
				<div className={PROPOSAL_BODY_CLASS} data-testid="notebook-change-body">
					{change.op === "update" && !whole ? (
						<NotebookDiff lines={change.diff ?? []} />
					) : (
						<div className="rounded-xs bg-(--vscode-editor-background) px-1 py-1">
							<MarkedNote content={content} diff={change.op === "create" ? [] : (change.diff ?? [])} />
						</div>
					)}
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
						<LinkButton className="text-[11px]" onClick={() => setWhole((value) => !value)}>
							{whole ? "Show changes" : "Show whole note"}
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
