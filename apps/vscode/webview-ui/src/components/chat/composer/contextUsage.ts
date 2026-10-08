import type { ClineCompactionInfo, ClineMessage, ExtensionState, TurnPhase } from "@shared/ExtensionMessage"

/** Usage at or above which the ring turns yellow. */
export const CONTEXT_WARN_PERCENT = 70
/** Usage above which the ring turns red. */
export const CONTEXT_HIGH_PERCENT = 90
/** Usage at or above which the composer offers a one-click Compact. */
export const COMPACT_NUDGE_PERCENT = 85

export type ContextUsageLevel = "ok" | "warn" | "high"

/** Theme chart colors, so the ring follows the active VS Code theme. */
export const CONTEXT_USAGE_COLORS: Record<ContextUsageLevel, string> = {
	ok: "var(--vscode-charts-green)",
	warn: "var(--vscode-charts-yellow)",
	high: "var(--vscode-charts-red)",
}

/** Percent of the context window used by the last request, clamped to 0–100; undefined when the window is unknown. */
export function contextUsagePercent(used: number | undefined, contextWindow: number | undefined): number | undefined {
	if (!contextWindow || contextWindow <= 0) {
		return undefined
	}
	return Math.min(100, Math.max(0, ((used ?? 0) / contextWindow) * 100))
}

/** The one-click Compact pill shows from `COMPACT_NUDGE_PERCENT` while compaction is possible. */
export function showsCompactNudge(canCompact: boolean, percent: number | undefined): boolean {
	return canCompact && percent !== undefined && percent >= COMPACT_NUDGE_PERCENT
}

export function contextUsageLevel(percent: number): ContextUsageLevel {
	if (percent > CONTEXT_HIGH_PERCENT) {
		return "high"
	}
	return percent >= CONTEXT_WARN_PERCENT ? "warn" : "ok"
}

/** "$0.42"; sub-cent spend reads "<$0.01". Undefined when there is nothing to show. */
export function formatChatCost(cost: number | undefined): string | undefined {
	if (!cost || !Number.isFinite(cost) || cost <= 0) {
		return undefined
	}
	return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`
}

/** True while the latest compaction divider is still in its "started" state. */
export function isCompactionRunning(messages: readonly ClineMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.type !== "say" || message.say !== "compaction") {
			continue
		}
		try {
			return (JSON.parse(message.text ?? "") as ClineCompactionInfo)?.status === "started"
		} catch {
			return false
		}
	}
	return false
}

export interface CompactAvailability {
	turnPhase?: TurnPhase
	/** The focused chat's runtime status from `sessionStatuses`. */
	sessionStatus?: ExtensionState["sessionStatuses"][string]
	/** Legacy hosts without `turnState`: the transcript tail says a request is in flight. */
	legacyRunning?: boolean
	isSubagentView?: boolean
	errorRecoveryAvailable?: boolean
	compactionRunning?: boolean
}

/**
 * Whether the host will accept a compaction now. It refuses while the session runs, which includes a
 * live question: `ask_question` reports `awaiting_followup` while the runtime is still active (status
 * "waiting"), unlike a followup after the turn ended (status "done"). It also refuses while an
 * approval is pending, while a compaction is already running, in read-only subagent threads, and
 * while recovery is offered.
 */
export function canCompactNow({
	turnPhase,
	sessionStatus,
	legacyRunning,
	isSubagentView,
	errorRecoveryAvailable,
	compactionRunning,
}: CompactAvailability): boolean {
	return (
		turnPhase !== "streaming" &&
		turnPhase !== "awaiting_approval" &&
		sessionStatus !== "running" &&
		sessionStatus !== "waiting" &&
		!legacyRunning &&
		!isSubagentView &&
		!errorRecoveryAvailable &&
		!compactionRunning
	)
}
