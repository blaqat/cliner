import type { ClineMessage } from "@shared/ExtensionMessage"
import type { NotebookChangesPayload } from "@shared/task-groups"

export function latestNotebookChangesMessage(
	messages: ClineMessage[],
	groupId?: string,
	revision?: string,
): ClineMessage | undefined {
	return [...messages].reverse().find((message) => {
		if (message.type !== "say" || message.say !== "notebook_changes") return false
		try {
			const payload = JSON.parse(message.text ?? "{}")
			return (
				(groupId === undefined || payload.taskGroupId === groupId) &&
				(revision === undefined || payload.revision === revision)
			)
		} catch {
			return false
		}
	})
}

export function notebookChangesMessage(payload: NotebookChangesPayload, ts: number): ClineMessage {
	return { ts, type: "say", say: "notebook_changes", text: JSON.stringify(payload), partial: false }
}

export function mergeNotebookChangesMessages(messages: ClineMessage[], saved: unknown, nextTs: () => number): ClineMessage[] {
	if (!Array.isArray(saved) || !saved.length) return messages
	const merged = [...messages]
	for (const raw of saved) {
		if (!raw || typeof raw !== "object" || raw.say !== "notebook_changes" || typeof raw.text !== "string") continue
		const card = raw as ClineMessage
		const anchor = card.sdkMessageIndex
		let index = merged.length
		if (anchor !== undefined) {
			const next = merged.findIndex((message) => message.sdkMessageIndex !== undefined && message.sdkMessageIndex > anchor)
			if (next >= 0) index = next
		}
		merged.splice(index, 0, { ...card, seq: undefined, epoch: undefined })
	}
	// History projections get fresh identities on every reopen. Persisted live
	// identities are process-local and must never collide with the new projection.
	return merged.map((message) => ({ ...message, ts: nextTs() }))
}

export function restoreNotebookChanges(
	messages: ClineMessage[],
	threadId: string,
	pending: { groupId: string; revision: string; changes: NotebookChangesPayload["changes"] }[] | undefined,
	nextTs: () => number,
): ClineMessage[] {
	let restored = [...messages]
	const groupIds = new Set((pending ?? []).map((review) => review.groupId))
	for (const review of pending ?? []) {
		const latest = latestNotebookChangesMessage(restored, review.groupId)
		const reuse = latest && JSON.parse(latest.text ?? "{}").status === "pending"
		const message = notebookChangesMessage(
			{ taskGroupId: review.groupId, threadId, revision: review.revision, status: "pending", changes: review.changes },
			reuse ? latest.ts : nextTs(),
		)
		if (reuse) message.sdkMessageIndex = latest.sdkMessageIndex
		restored = reuse ? restored.map((entry) => (entry === latest ? message : entry)) : [...restored, message]
	}
	// Only settle the latest pending card per absent group; preserve older reviews.
	for (const message of restored) {
		if (message.say !== "notebook_changes") continue
		try {
			const payload = JSON.parse(message.text ?? "{}") as NotebookChangesPayload
			if (
				payload.status === "pending" &&
				!groupIds.has(payload.taskGroupId) &&
				latestNotebookChangesMessage(restored, payload.taskGroupId) === message
			) {
				restored = restored.map((entry) =>
					entry === message ? notebookChangesMessage({ ...payload, status: "discarded" }, message.ts) : entry,
				)
			}
		} catch {}
	}
	return restored
}
