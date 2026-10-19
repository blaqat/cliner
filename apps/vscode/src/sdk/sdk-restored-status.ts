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
