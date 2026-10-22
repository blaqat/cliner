import { CreateNoteRequest } from "@shared/proto/cline/task_group"
import type { NotebookNoteMeta } from "@shared/task-groups"
import { type FormEvent, useMemo, useState } from "react"
import { formatAge } from "@/components/inbox/inboxUtils"
import { Button } from "@/components/ui/button"
import { TaskGroupServiceClient } from "@/services/grpc-client"
import { NotebookNoteView } from "./NotebookNoteView"
import { TaskGroupPageHeader } from "./TaskGroupPageHeader"
import { consumeNewNoteRequest, formatNoteSize, openNote, useTaskGroup } from "./useTaskGroup"

const FIELD_CLASS =
	"w-full rounded-xs border border-input-border bg-input-background px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"

/** Slug of a created note from its path (`…/notebook/<slug>.md`). */
export function noteSlugFromPath(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? ""
	return base.replace(/\.md$/i, "")
}

export function noteMetaLine(note: NotebookNoteMeta, now: number): string {
	const writer = note.updatedBy.kind === "user" ? "by you" : note.updatedBy.threadTitle || "a thread"
	return [formatNoteSize(note.size), writer, formatAge(note.updatedAt, now), note.readers > 0 && `read by ${note.readers}`]
		.filter(Boolean)
		.join(" · ")
}

interface NotebookViewProps {
	taskGroupId: string
	now?: number
}

/** A task's notebook as a list. Notes open as markdown files in the editor; `＋ New note` creates one inline. */
export const NotebookView = ({ taskGroupId, now = Date.now() }: NotebookViewProps) => {
	const { details, missing, refresh } = useTaskGroup(taskGroupId)
	const [selected, setSelected] = useState<NotebookNoteMeta>()
	const [filter, setFilter] = useState("")
	const [creating, setCreating] = useState(consumeNewNoteRequest)

	const notes = useMemo(() => {
		const query = filter.trim().toLowerCase()
		return [...(details?.notes ?? [])]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.filter((note) => !query || `${note.name}\n${note.description}`.toLowerCase().includes(query))
	}, [details?.notes, filter])

	if (selected && details)
		return (
			<NotebookNoteView
				key={selected.slug}
				note={selected}
				onBack={() => {
					setSelected(undefined)
					refresh()
				}}
				taskGroupId={taskGroupId}
				taskTitle={details.group.title}
			/>
		)

	return (
		<div className="flex flex-1 flex-col overflow-hidden" data-testid="notebook-view">
			<TaskGroupPageHeader notebook taskGroupId={taskGroupId} title={details?.group.title ?? "Task"} />
			{missing ? (
				<div className="px-4 py-3 text-sm text-description">This task no longer exists.</div>
			) : (
				<div className="flex-1 overflow-y-auto pb-2">
					<div className="flex items-center gap-1.5 px-4 py-2">
						<div className="flex min-w-0 flex-1 items-center gap-1 rounded-xs border border-input-border bg-input-background px-1.5 focus-within:outline focus-within:outline-1 focus-within:outline-(--vscode-focusBorder)">
							<span aria-hidden className="codicon codicon-search text-[12px] text-description" />
							<input
								aria-label="Filter notes"
								className="h-6 min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-input-foreground outline-none placeholder:text-input-placeholder"
								onChange={(event) => setFilter(event.target.value)}
								placeholder="Filter notes…"
								value={filter}
							/>
						</div>
						<Button onClick={() => setCreating((value) => !value)} size="xs">
							＋ New note
						</Button>
					</div>
					{creating && (
						<NewNoteForm
							onCancel={() => setCreating(false)}
							onCreated={() => {
								setCreating(false)
								refresh()
							}}
							taskGroupId={taskGroupId}
						/>
					)}
					{details && notes.length === 0 && (
						<div className="px-4 py-1 text-xs text-description">
							{filter.trim()
								? "No notes match."
								: "No notes yet. Threads in this task write notes as they learn things."}
						</div>
					)}
					<ul className="m-0 list-none px-2 py-0">
						{notes.map((note) => (
							<li key={note.slug}>
								<button
									className="flex w-full cursor-pointer items-start gap-2 rounded-xs border border-transparent bg-transparent px-2 py-1.5 text-left hover:border-editor-group-border hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
									data-testid="notebook-note-row"
									onClick={() => setSelected(note)}
									title={`View ${note.name}`}
									type="button">
									<span
										aria-hidden
										className="codicon codicon-book mt-0.5 text-[12px] text-(--vscode-charts-purple)"
									/>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-[13px] text-foreground">{note.name}</span>
										{note.description && (
											<span className="truncate text-[11px] text-foreground/75">{note.description}</span>
										)}
										<span className="truncate text-[11px] text-description">{noteMetaLine(note, now)}</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	)
}

function NewNoteForm({ taskGroupId, onCreated, onCancel }: { taskGroupId: string; onCreated: () => void; onCancel: () => void }) {
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string>()

	const submit = async (event: FormEvent) => {
		event.preventDefault()
		if (!name.trim() || saving) return
		setSaving(true)
		setError(undefined)
		try {
			const { path } = await TaskGroupServiceClient.createNote(
				CreateNoteRequest.create({ taskGroupId, name: name.trim(), description: description.trim() }),
			)
			openNote(taskGroupId, noteSlugFromPath(path))
			onCreated()
		} catch (err) {
			console.error("Failed to create note:", err)
			setError("Couldn't create the note. Try again.")
			setSaving(false)
		}
	}

	return (
		<form
			className="mx-4 mb-2 rounded-sm border border-[color-mix(in_srgb,var(--vscode-charts-purple)_40%,transparent)] bg-[color-mix(in_srgb,var(--vscode-charts-purple)_6%,transparent)] p-2.5"
			data-testid="notebook-new-note-form"
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation()
					onCancel()
				}
			}}
			onSubmit={submit}>
			<div className="text-xs font-semibold text-foreground">New note</div>
			<label className="mt-2 mb-1 block text-[11px] text-description" htmlFor="new-note-name">
				Name
			</label>
			<input
				className={FIELD_CLASS}
				id="new-note-name"
				onChange={(event) => setName(event.target.value)}
				placeholder="Review checklist"
				required
				value={name}
			/>
			<label className="mt-2 mb-1 block text-[11px] text-description" htmlFor="new-note-description">
				Description <span className="opacity-75">(what agents see in the index)</span>
			</label>
			<input
				className={FIELD_CLASS}
				id="new-note-description"
				onChange={(event) => setDescription(event.target.value)}
				placeholder="What it covers, in one line"
				value={description}
			/>
			{error && (
				<div className="mt-1.5 text-xs text-error" role="alert">
					{error}
				</div>
			)}
			<div className="mt-2.5 flex gap-1.5">
				<Button disabled={!name.trim() || saving} size="xs" type="submit">
					Create &amp; open
				</Button>
				<Button onClick={onCancel} size="xs" type="button" variant="secondary">
					Cancel
				</Button>
			</div>
		</form>
	)
}
