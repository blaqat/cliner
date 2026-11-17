import type { HistoryItem } from "@shared/HistoryItem"
import { SetThreadTagsRequest } from "@shared/proto/cline/task"
import type { TaskTag } from "@shared/task-groups"
import { useEffect, useMemo, useRef, useState } from "react"
import { effectiveThreadTags, sameTag } from "@/components/taskGroup/effectiveThreadTags"
import { TaskTagEditor } from "@/components/taskGroup/TaskTagEditor"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"

interface ThreadTags {
	tags: TaskTag[]
	dismissedAutoTags: string[]
}

interface ThreadTagRowProps {
	item: HistoryItem
	currentBranch?: string
}

/**
 * The thread's tags under the header: the task's tags first (muted, no ×), then chips with × (removing an auto tag
 * dismisses it so detection won't re-add it), "＋ tag" and a suggested current
 * branch. Edits show at once and roll back if the save fails.
 */
export const ThreadTagRow = ({ item, currentBranch }: ThreadTagRowProps) => {
	const { taskHistory, taskGroups } = useExtensionState()
	const inheritedTags = useMemo(
		() => effectiveThreadTags(item, taskHistory, taskGroups).filter((entry) => entry.inherited),
		[item, taskHistory, taskGroups],
	)
	// Shown until the save settles; the saved tags then come back through history.
	const [pending, setPending] = useState<ThreadTags>()
	const latestRequest = useRef(0)

	// biome-ignore lint/correctness/useExhaustiveDependencies: a different thread drops any pending edit
	useEffect(() => {
		latestRequest.current++
		setPending(undefined)
	}, [item.id])

	const current: ThreadTags = pending ?? { tags: item.tags ?? [], dismissedAutoTags: item.dismissedAutoTags ?? [] }

	const save = (next: ThreadTags) => {
		const request = ++latestRequest.current
		setPending(next)
		TaskServiceClient.setThreadTags(
			SetThreadTagsRequest.create({ taskId: item.id, tags: next.tags, dismissedAutoTags: next.dismissedAutoTags }),
		)
			.catch((error) => console.error("Failed to save thread tags:", error))
			.finally(() => {
				// Only the newest edit settles the view; on failure this rolls back to the saved tags.
				if (request === latestRequest.current) setPending(undefined)
			})
	}

	const add = (tag: Pick<TaskTag, "kind" | "value">) => {
		if (current.tags.some((other) => sameTag(other, tag))) return
		save({ ...current, tags: [...current.tags, { ...tag, source: "user" }] })
	}
	const remove = (tag: TaskTag) => {
		const dismissed = current.dismissedAutoTags
		save({
			tags: current.tags.filter((other) => other !== tag),
			dismissedAutoTags:
				tag.source === "auto" && !dismissed.some((value) => value.toLowerCase() === tag.value.toLowerCase())
					? [...dismissed, tag.value]
					: dismissed,
		})
	}

	return (
		<TaskTagEditor
			className={cn(
				"mt-1 px-0.5",
				// Without tags the affordances stay quiet until the row is hovered or focused.
				!current.tags.length &&
					!inheritedTags.length &&
					"opacity-60 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
			)}
			data-testid="thread-tag-row"
			inheritedTags={inheritedTags}
			onAdd={add}
			onRemove={remove}
			revealRemove
			suggestedBranch={currentBranch}
			tags={current.tags}
		/>
	)
}
