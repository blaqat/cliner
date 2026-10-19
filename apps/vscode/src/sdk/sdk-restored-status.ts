import type { SessionHistoryRecord } from "@cline/core"
import type { ExtensionState } from "@shared/ExtensionMessage"

/** Persisted UI decisions survive the aborts used to tear down the runtime. */
export function restoredThreadStatus(
	record: Pick<SessionHistoryRecord, "status" | "metadata">,
): ExtensionState["sessionStatuses"][string] {
	const saved = record.metadata?.vscodeThreadStatus
	if (record.status === "failed" || saved === "error") return "error"
	if (saved === "waiting") return "waiting"
	if (record.status === "cancelled" || record.status === "running" || saved === "stopped") return "stopped"
	if (record.status === "pending") return "waiting"
	return "done"
}
