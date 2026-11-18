import type { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { asideTitle, type LineageRow } from "@/components/chat/chat-view/utils/threadUtils"
import type { SessionStatuses } from "@/components/inbox/inboxUtils"
import { buildThreadStatuses, type ThreadStatus, threadStatusFor } from "@/components/inbox/threadStatus"

const EDIT_TOOLS = new Set<ClineSayTool["tool"]>(["editedExistingFile", "newFileCreated", "fileDeleted"])

/** Files this thread edited, created or deleted, from its tool rows (no host call). */
export function changedFiles(messages: readonly ClineMessage[]): string[] {
	const paths = new Set<string>()
	for (const message of messages) {
		if (message.say !== "tool" && message.ask !== "tool") continue
		if (message.partial) continue
		try {
			const tool = JSON.parse(message.text ?? "{}") as Partial<ClineSayTool>
			if (tool.tool && EDIT_TOOLS.has(tool.tool) && tool.path) paths.add(tool.path)
		} catch {
			// Not a tool payload.
		}
	}
	return [...paths]
}

export type AgentKind = "side" | "btw" | "subagent"

export interface AgentRow {
	id: string
	kind: AgentKind
	title: string
	status: ThreadStatus
	/** A side thread the user closed, or a side question that wasn't kept. */
	tucked: boolean
	/** Last activity, for ordering. */
	ts: number
	access?: "read" | "write"
	previewOnly?: boolean
	parentTaskId?: string
	cost?: number
}

/** Side threads (any kind) forked from this thread, plus its subagents, newest activity first. */
export function buildAgentRows(
	threadId: string,
	history: readonly HistoryItem[],
	statuses: SessionStatuses | undefined,
	subagents: readonly LineageRow[],
): AgentRow[] {
	const derived = buildThreadStatuses(history, statuses)
	const sides: AgentRow[] = history
		.filter((item) => item.parentTaskId === threadId && !item.isSubagent)
		.map((item) => ({
			id: item.id,
			kind: item.sideKind === "btw" ? "btw" : "side",
			title: asideTitle(item),
			status: threadStatusFor(derived, item.id),
			tucked: !!item.sideClosedAt || item.sideKind === "btw",
			ts: item.ts,
		}))
	const byId = new Map(history.map((item) => [item.id, item]))
	const agents: AgentRow[] = subagents.map((row) => ({
		id: row.id,
		kind: "subagent",
		title: row.title,
		status: row.status,
		tucked: false,
		ts: byId.get(row.id)?.ts ?? 0,
		access: row.access,
		previewOnly: row.previewOnly,
		parentTaskId: row.parentTaskId,
		cost: row.cost,
	}))
	return [...sides, ...agents].sort((a, b) => b.ts - a.ts)
}

export function isLiveAgent(row: AgentRow): boolean {
	return row.status === "running" || row.status === "waiting" || row.status === "subagents"
}

/** How many finished rows show before "Show N more". */
export const RECENT_FINISHED = 3

/**
 * What the Agents section lists up front: everything live, then the most recent finished
 * ones. Older finished rows, closed side threads and side questions wait behind "Show more".
 */
export function splitAgentRows(rows: readonly AgentRow[]): { shown: AgentRow[]; more: AgentRow[] } {
	const live = rows.filter((row) => isLiveAgent(row) && !row.tucked)
	const finished = rows.filter((row) => !isLiveAgent(row) && !row.tucked)
	const tucked = rows.filter((row) => row.tucked)
	return {
		shown: [...live, ...finished.slice(0, RECENT_FINISHED)],
		more: [...finished.slice(RECENT_FINISHED), ...tucked],
	}
}

/** "412k", "1m", "950": token counts the way the context bar reads them. */
export function shortTokens(count: number): string {
	if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1))}m`
	if (count >= 1_000) return `${Math.round(count / 1_000)}k`
	return String(Math.round(count))
}
