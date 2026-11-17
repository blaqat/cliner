import type { TaskTag } from "@shared/task-groups"
import { type KeyboardEvent, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { type EffectiveTag, sameTag } from "./effectiveThreadTags"
import { parseTagInput } from "./NewTaskGroupSheet"
import { TaskTagChip } from "./TaskTagChip"

export { sameTag }

/** True when `branch` is set and not already one of `tags`. */
export const shouldSuggestBranch = (tags: readonly TaskTag[], branch: string | undefined): branch is string =>
	!!branch && !tags.some((tag) => sameTag(tag, { kind: "branch", value: branch }))

interface TaskTagEditorProps {
	tags: readonly TaskTag[]
	/** The task's tags, shown first and muted; they can't be removed here. */
	inheritedTags?: readonly EffectiveTag[]
	onAdd: (tag: Pick<TaskTag, "kind" | "value">) => void
	onRemove: (tag: TaskTag) => void
	/** Shown as a dashed "＋ ⎇ branch" chip when it isn't tagged yet. */
	suggestedBranch?: string
	/** Hides each chip's × until the chip is hovered or focused. */
	revealRemove?: boolean
	className?: string
	"data-testid"?: string
}

/**
 * Tag chips with × to remove, a "＋ tag" button that opens an inline input
 * (Enter adds; a lone ticket key or issue URL becomes a ticket, anything else a
 * label) and an optional suggested-branch chip. Used by tasks and threads.
 */
export const TaskTagEditor = ({
	tags,
	inheritedTags,
	onAdd,
	onRemove,
	suggestedBranch,
	revealRemove,
	className,
	"data-testid": testId,
}: TaskTagEditorProps) => {
	const [adding, setAdding] = useState(false)
	return (
		<div className={cn("flex min-w-0 flex-wrap items-center gap-1", className)} data-testid={testId}>
			{inheritedTags?.map(({ tag, taskTitle }) => (
				<TaskTagChip
					inheritedFrom={taskTitle ?? "task"}
					key={`inherited:${tag.kind}:${tag.value}`}
					kind={tag.kind}
					value={tag.value}
				/>
			))}
			{tags.map((tag) => (
				<TaskTagChip
					key={`${tag.kind}:${tag.value}`}
					kind={tag.kind}
					onRemove={() => onRemove(tag)}
					revealRemove={revealRemove}
					value={tag.value}
				/>
			))}
			{adding ? (
				<TagInput
					onDone={(text) => {
						setAdding(false)
						const parsed = parseTagInput(text)
						if (parsed) onAdd(parsed)
					}}
				/>
			) : (
				<button
					className="inline-flex h-4 shrink-0 cursor-pointer items-center rounded-full border border-dashed border-description/50 bg-transparent px-1.5 text-[10.5px] leading-none text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					onClick={() => setAdding(true)}
					type="button">
					＋ tag
				</button>
			)}
			{shouldSuggestBranch([...tags, ...(inheritedTags?.map((entry) => entry.tag) ?? [])], suggestedBranch) && (
				<TaskTagChip
					kind="branch"
					onAdd={() => onAdd({ kind: "branch", value: suggestedBranch })}
					value={suggestedBranch}
				/>
			)}
		</div>
	)
}

function TagInput({ onDone }: { onDone: (text: string) => void }) {
	const [draft, setDraft] = useState("")
	const settledRef = useRef(false)
	const finish = (text: string) => {
		if (settledRef.current) return
		settledRef.current = true
		onDone(text)
	}
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault()
			finish(draft)
		} else if (event.key === "Escape") {
			event.preventDefault()
			event.stopPropagation()
			finish("")
		}
	}
	return (
		<input
			aria-label="New tag"
			autoFocus
			className="h-4.5 w-36 min-w-0 max-w-full rounded-xs border border-(--vscode-focusBorder) bg-input-background px-1.5 text-[11px] text-input-foreground outline-none placeholder:text-input-placeholder"
			onBlur={() => finish(draft)}
			onChange={(event) => setDraft(event.target.value)}
			onKeyDown={onKeyDown}
			placeholder="ticket, label or branch:name…"
			value={draft}
		/>
	)
}
