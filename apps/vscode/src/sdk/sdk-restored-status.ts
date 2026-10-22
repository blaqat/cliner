import type { SessionHistoryRecord } from "@cline/core"
import type { ExtensionState } from "@shared/ExtensionMessage"

const LEGACY_RELOAD_MARKER = "failed_external_process_exit"

/** Persisted UI decisions survive the aborts used to tear down the runtime. */
export function restoredThreadStatus(
	record: Pick<SessionHistoryRecord, "status" | "metadata">,
): ExtensionState["sessionStatuses"][string] {
	const saved = record.metadata?.vscodeThreadStatus
	// Older builds marked idle (finished) threads failed when the window closed. That marker
	// never meant the turn failed, so show those records as done instead of as errors.
	if (record.status === "failed" && saved !== "error" && record.metadata?.terminal_marker === LEGACY_RELOAD_MARKER)
		return "done"
	if (record.status === "failed" || saved === "error") return "error"
	if (saved === "waiting") return "waiting"
	if (record.status === "cancelled" || record.status === "running" || saved === "stopped") return "stopped"
	if (record.status === "pending") return "waiting"
	return "done"
}

/**
 * Whether the thread's last turn ended cleanly. The SDK only writes "completed" when the
 * session is released gracefully; a window reload or crash leaves "idle" regardless of how the
 * last turn ended (aborted turns also go idle). The extension's own persisted thread status
 * disambiguates: "done" is written when a turn finishes and "stopped" when the user cancels it.
 * Anything else (failed, cancelled, running, pending, or an idle record with no saved status)
 * is treated as not completed, so its trailing response stays plain text and Resume is offered.
 */
export function lastTurnCompleted(record: Pick<SessionHistoryRecord, "status" | "metadata">): boolean {
	if (record.status === "completed") return true
	return record.status === "idle" && record.metadata?.vscodeThreadStatus === "done"
}
