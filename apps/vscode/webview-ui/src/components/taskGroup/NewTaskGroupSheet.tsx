import { CreateTaskGroupRequest, SetThreadTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { TaskTag, TaskTagKind } from "@shared/task-groups"
import { extractTicketTags } from "@shared/ticket-tags"
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskGroupServiceClient } from "@/services/grpc-client"
import { TaskTagChip } from "./TaskTagChip"

/**
 * Where the sheet was opened: home's "＋ Task" (empty task), the task pill in a
 * new-thread composer (the next message starts the first thread), or the pill
 * on an existing thread (that thread moves into the new task).
 */
export type NewTaskGroupOrigin = "home" | "composer" | "thread"

interface NewTaskGroupSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	origin: NewTaskGroupOrigin
	/** Ticket keys found in the composer draft; prefilled as tags. */
	detectedTickets?: string[]
	/** The existing thread to file into the new task (origin "thread"). */
	threadId?: string
	onCreated?: (id: string) => void
}

const sameValue = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** A typed tag: a lone ticket key or issue URL is a ticket, anything else a label. */
export function parseTagInput(text: string): Pick<TaskTag, "kind" | "value"> | undefined {
	const value = text.trim()
	if (!value) return undefined
	const tickets = extractTicketTags(value)
	if (tickets.length === 1 && (sameValue(tickets[0], value) || /^https?:\/\//.test(value))) {
		return { kind: "ticket", value: tickets[0] }
	}
	return { kind: "label", value }
}

function describeOrigin(origin: NewTaskGroupOrigin, detected: string[]): string {
	if (origin === "home") return "Creates an empty task. Start threads from its page or pick it with the task pill."
	if (origin === "thread") return "This thread moves into the new task."
	const from = detected.length ? `${detected.join(", ")} came from your message. ` : ""
	return `${from}Your message starts the first thread in this task.`
}

/** Bottom sheet that creates a task group (title + tags). */
export const NewTaskGroupSheet = ({
	open,
	onOpenChange,
	origin,
	detectedTickets = [],
	threadId,
	onCreated,
}: NewTaskGroupSheetProps) => {
	const { currentBranch } = useExtensionState()
	const [title, setTitle] = useState("")
	const [tags, setTags] = useState<TaskTag[]>([])
	const [tagDraft, setTagDraft] = useState("")
	const [creating, setCreating] = useState(false)
	const [error, setError] = useState<string>()
	const detectedKey = detectedTickets.join("\n")

	// Every open starts fresh; tickets from the draft are prefilled.
	useEffect(() => {
		if (!open) return
		setTitle("")
		setTagDraft("")
		setError(undefined)
		setCreating(false)
		setTags(detectedKey ? detectedKey.split("\n").map((value) => ({ kind: "ticket", value, source: "auto" })) : [])
	}, [open, detectedKey])

	const addTag = (kind: TaskTagKind, value: string) =>
		setTags((current) =>
			current.some((tag) => tag.kind === kind && sameValue(tag.value, value))
				? current
				: [...current, { kind, value, source: "user" }],
		)
	const commitDraft = () => {
		const parsed = parseTagInput(tagDraft)
		if (parsed) addTag(parsed.kind, parsed.value)
		setTagDraft("")
	}
	const onTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if ((event.key === "Enter" || event.key === ",") && tagDraft.trim()) {
			event.preventDefault()
			commitDraft()
		} else if (event.key === "Backspace" && !tagDraft && tags.length) {
			setTags((current) => current.slice(0, -1))
		}
	}

	const suggestBranch = !!currentBranch && !tags.some((tag) => tag.kind === "branch" && sameValue(tag.value, currentBranch))
	const canCreate = !!title.trim() && !creating

	const submit = async (event?: FormEvent) => {
		event?.preventDefault()
		if (!canCreate) return
		const draft = parseTagInput(tagDraft)
		const allTags =
			draft && !tags.some((tag) => tag.kind === draft.kind && sameValue(tag.value, draft.value))
				? [...tags, { ...draft, source: "user" as const }]
				: tags
		setCreating(true)
		setError(undefined)
		try {
			const { id } = await TaskGroupServiceClient.createTaskGroup(
				CreateTaskGroupRequest.create({ title: title.trim(), tags: allTags }),
			)
			// Filed in a separate call so moving an existing thread goes through the
			// same path as the pill (the backend rebuilds the session there).
			if (threadId) {
				await TaskGroupServiceClient.setThreadTaskGroup(SetThreadTaskGroupRequest.create({ threadId, taskGroupId: id }))
			}
			onCreated?.(id)
			onOpenChange(false)
		} catch (err) {
			console.error("Failed to create task:", err)
			setError("Couldn't create the task. Try again.")
			setCreating(false)
		}
	}

	const labelClass = "mt-2.5 mb-1 block text-[11px] text-description"

	return (
		<Sheet onOpenChange={onOpenChange} open={open}>
			<SheetContent aria-describedby="new-task-sheet-description" data-testid="new-task-sheet">
				<form onSubmit={submit}>
					<div className="flex items-center">
						<SheetTitle className="flex-1">New task</SheetTitle>
						<SheetClose
							aria-label="Close"
							className="flex size-5 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground">
							<span className="codicon codicon-close" />
						</SheetClose>
					</div>
					<label className={labelClass} htmlFor="new-task-title">
						Title
					</label>
					<input
						autoFocus
						className="w-full rounded-xs border border-input-border bg-input-background px-2 py-1 text-sm text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"
						id="new-task-title"
						onChange={(event) => setTitle(event.target.value)}
						placeholder="What is this task about?"
						required
						value={title}
					/>
					<label className={labelClass} htmlFor="new-task-tags">
						Tags
					</label>
					<div className="flex min-h-7 w-full flex-wrap items-center gap-1 rounded-xs border border-input-border bg-input-background px-1.5 py-1 focus-within:outline focus-within:outline-1 focus-within:outline-(--vscode-focusBorder)">
						{tags.map((tag) => (
							<TaskTagChip
								key={`${tag.kind}:${tag.value}`}
								kind={tag.kind}
								onRemove={() => setTags((current) => current.filter((other) => other !== tag))}
								value={tag.value}
							/>
						))}
						<input
							className="min-w-24 flex-1 border-0 bg-transparent p-0 text-xs text-input-foreground outline-none placeholder:text-input-placeholder"
							id="new-task-tags"
							onBlur={commitDraft}
							onChange={(event) => setTagDraft(event.target.value)}
							onKeyDown={onTagKeyDown}
							placeholder={tags.length ? "" : "ticket, branch or label…"}
							value={tagDraft}
						/>
					</div>
					{suggestBranch && currentBranch && (
						<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-description">
							<span>Suggested</span>
							<TaskTagChip kind="branch" onAdd={() => addTag("branch", currentBranch)} value={currentBranch} />
							<span>current branch</span>
						</div>
					)}
					<SheetDescription className="mt-2.5" id="new-task-sheet-description">
						{describeOrigin(origin, detectedTickets)}
					</SheetDescription>
					{error && (
						<div className="mt-1.5 text-xs text-error" role="alert">
							{error}
						</div>
					)}
					<div className="mt-3 flex gap-1.5">
						<Button disabled={!canCreate} size="sm" type="submit">
							Create task
						</Button>
						<SheetClose asChild>
							<Button size="sm" type="button" variant="secondary">
								Cancel
							</Button>
						</SheetClose>
					</div>
				</form>
			</SheetContent>
		</Sheet>
	)
}
