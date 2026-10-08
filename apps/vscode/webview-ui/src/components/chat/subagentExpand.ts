/**
 * Lightweight signal from the threads strip to the transcript: clicking a
 * subagent chip asks the SubagentStatusRow for that message to expand the
 * item's prompt and output details.
 *
 * The request is stored as a pending target rather than fired as a transient
 * event, because Virtuoso only renders rows near the viewport — a row outside
 * the rendered range would miss a one-shot event. A row consumes the pending
 * target when it mounts; an already-mounted row consumes it via subscription.
 */
type ExpandTarget = { ts: number; index: number }

let pendingTarget: ExpandTarget | null = null
const listeners = new Set<(messageTs: number, itemIndex: number) => void>()

export function emitSubagentExpand(messageTs: number, itemIndex: number): void {
	pendingTarget = { ts: messageTs, index: itemIndex }
	for (const listener of listeners) {
		listener(messageTs, itemIndex)
	}
}

/** Subscribe to expand requests; returns an unsubscribe function. */
export function onSubagentExpand(listener: (messageTs: number, itemIndex: number) => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/**
 * Return the pending expand request for `messageTs` and clear it, or null when
 * the pending target is for a different message (left in place for its row).
 */
export function consumeSubagentExpand(messageTs: number): number | null {
	if (pendingTarget?.ts !== messageTs) {
		return null
	}
	const { index } = pendingTarget
	pendingTarget = null
	return index
}

/** Drop any pending target — e.g. when switching tasks makes it stale. */
export function clearSubagentExpandTarget(): void {
	pendingTarget = null
}
