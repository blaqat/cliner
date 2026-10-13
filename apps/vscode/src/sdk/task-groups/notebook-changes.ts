import type { ClineMessage } from "@shared/ExtensionMessage"
import type { NotebookChangesPayload } from "@shared/task-groups"

export function latestNotebookChangesMessage(messages: ClineMessage[]): ClineMessage | undefined {
	return [...messages].reverse().find((message) => message.type === "say" && message.say === "notebook_changes")
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
	pending: { groupId: string; changes: NotebookChangesPayload["changes"] } | undefined,
	nextTs: () => number,
): ClineMessage[] {
	const latest = latestNotebookChangesMessage(messages)
	if (pending?.changes.length) {
		let reuse = false
		try {
			reuse = latest !== undefined && JSON.parse(latest.text ?? "{}").status === "pending"
		} catch {}
		const message = notebookChangesMessage(
			{ taskGroupId: pending.groupId, threadId, status: "pending", changes: pending.changes },
			reuse && latest ? latest.ts : nextTs(),
		)
		if (reuse) message.sdkMessageIndex = latest?.sdkMessageIndex
		return reuse ? messages.map((entry) => (entry === latest ? message : entry)) : [...messages, message]
	}
	if (latest) {
		try {
			const payload = JSON.parse(latest.text ?? "{}") as NotebookChangesPayload
			if (payload.status === "pending") {
				return messages.map((entry) =>
					entry === latest ? notebookChangesMessage({ ...payload, status: "discarded" }, latest.ts) : entry,
				)
			}
		} catch {}
	}
	return messages
}
