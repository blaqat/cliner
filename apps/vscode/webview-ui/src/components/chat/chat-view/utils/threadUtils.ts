import type {
	ClineAskUseSubagents,
	ClineMessage,
	ClineSaySubagentStatus,
	SubagentExecutionStatus,
} from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { type SessionStatus, type SessionStatuses, statusFor } from "@/components/inbox/inboxUtils"

export type ThreadKind = "main" | "aside" | "subagent"

export interface ThreadItem {
	kind: ThreadKind
	/** Task id for main/aside; `<statusMessageTs>:<index>` for subagents. */
	id: string
	title: string
	status: SessionStatus
	/** True for the chip of the focused task. */
	current: boolean
	access?: "read" | "write"
	parentTaskId?: string
	/** Older transcripts without a saved child record retain their inline preview. */
	previewOnly?: boolean
}

const SUBAGENT_STATUS: Record<SubagentExecutionStatus, SessionStatus> = {
	pending: "waiting",
	running: "running",
	completed: "done",
	failed: "error",
	stopped: "error",
}

const ASIDE_PREFIX = /^Aside:\s*/i

function parseJson<T>(text: string | undefined): T | undefined {
	if (!text) {
		return undefined
	}
	try {
		return JSON.parse(text) as T
	} catch {
		return undefined
	}
}

/**
 * Subagents spawned in the focused transcript. `use_subagents` carries the
 * prompts and access levels; the following `subagent` status row (updated in
 * place under a stable ts) carries live status. A spawn with no status yet is
 * shown as waiting.
 */
export function collectSubagents(messages: readonly ClineMessage[]): ThreadItem[] {
	const items: ThreadItem[] = []
	let pendingSpawn: { ts: number; payload: ClineAskUseSubagents } | undefined

	const flushPending = () => {
		if (!pendingSpawn) {
			return
		}
		const { ts, payload } = pendingSpawn
		payload.prompts.forEach((prompt, index) => {
			items.push({
				kind: "subagent",
				id: `${ts}:${index + 1}`,
				title: prompt.trim(),
				status: "waiting",
				current: false,
				access: payload.access?.[index] ?? "read",
				previewOnly: true,
			})
		})
		pendingSpawn = undefined
	}

	for (const message of messages) {
		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			const payload = parseJson<ClineAskUseSubagents>(message.text)
			if (payload && Array.isArray(payload.prompts)) {
				// The combined prompts row replaces itself as spawns stream in.
				if (pendingSpawn && pendingSpawn.ts !== message.ts) {
					flushPending()
				}
				pendingSpawn = { ts: message.ts, payload }
			}
			continue
		}
		if (message.say === "subagent") {
			const status = parseJson<ClineSaySubagentStatus>(message.text)
			if (!status || !Array.isArray(status.items)) {
				continue
			}
			for (const item of status.items) {
				items.push({
					kind: "subagent",
					id: item.childSessionId ?? `${message.ts}:${item.index}`,
					previewOnly: !item.childSessionId,
					title: item.prompt.trim(),
					status: SUBAGENT_STATUS[item.status] ?? "done",
					current: false,
					access: item.access ?? pendingSpawn?.payload.access?.[item.index - 1] ?? "read",
				})
			}
			pendingSpawn = undefined
		}
	}
	flushPending()
	return items
}

/**
 * Chips for the human-made threads of the focused chat: Main and its asides.
 * Subagents live in the header's subagent panel instead. Returns [] when the
 * chat has no asides, or when a subagent thread is focused.
 */
export function buildThreadItems(
	focused: HistoryItem | undefined,
	history: readonly HistoryItem[],
	statuses: SessionStatuses | undefined,
	hiddenIds: ReadonlySet<string> = new Set(),
): ThreadItem[] {
	if (!focused || focused.isSubagent) {
		return []
	}
	const root = (focused.parentTaskId && history.find((item) => item.id === focused.parentTaskId)) || focused
	const items: ThreadItem[] = [
		{ kind: "main", id: root.id, title: "Main", status: statusFor(statuses, root.id), current: root.id === focused.id },
	]

	const asides = history
		.filter(
			(item) =>
				!item.isSubagent &&
				(item.parentTaskId === root.id || item.parentTaskId === focused.id) &&
				(!hiddenIds.has(item.id) || item.id === focused.id),
		)
		.sort((a, b) => a.ts - b.ts)
	for (const aside of asides) {
		items.push({
			kind: "aside",
			id: aside.id,
			title: asideTitle(aside),
			status: statusFor(statuses, aside.id),
			current: aside.id === focused.id,
		})
	}
	// An aside that is not yet in the (possibly lagging) history list still gets a chip.
	if (focused.id !== root.id && !asides.some((aside) => aside.id === focused.id)) {
		items.push({
			kind: "aside",
			id: focused.id,
			title: asideTitle(focused),
			status: statusFor(statuses, focused.id),
			current: true,
		})
	}

	return items.length > 1 ? items : []
}

export function asideTitle(item: HistoryItem): string {
	return item.task.replace(ASIDE_PREFIX, "") || "Aside"
}

export interface LineageRow {
	/** Task id; `<statusMessageTs>:<index>` for an unsaved transcript preview. */
	id: string
	title: string
	status: SessionStatus
	access?: "read" | "write"
	/** Older transcripts without a saved child record; opens by scrolling to its status row. */
	previewOnly?: boolean
	/** Task that spawned this row (the id to pass to stopSubagent). */
	parentTaskId?: string
}

export interface SubagentLineage {
	/** Immediate parent, only when the focused thread is a subagent. */
	parent?: LineageRow
	current: LineageRow
	/** Direct children of the focused thread, oldest first. */
	children: LineageRow[]
}

/**
 * One level up and one level down from the focused thread: its immediate
 * parent (when it is a subagent), itself, and the subagents it spawned. No
 * grandparents or grandchildren.
 */
export function buildSubagentLineage(
	focused: HistoryItem | undefined,
	history: readonly HistoryItem[],
	statuses: SessionStatuses | undefined,
	messages: readonly ClineMessage[],
	fallbackParentId?: string,
): SubagentLineage | undefined {
	if (!focused) {
		return undefined
	}
	const parentId = focused.isSubagent ? (focused.parentTaskId ?? fallbackParentId) : undefined
	const parentItem = parentId ? history.find((item) => item.id === parentId) : undefined
	const parent: LineageRow | undefined = parentId
		? {
				id: parentId,
				title: parentItem ? (parentItem.isSubagent ? parentItem.task : asideTitleOrTask(parentItem)) : "Parent",
				status: statusFor(statuses, parentId),
				access: parentItem?.isSubagent ? (parentItem.subagentAccess ?? "read") : undefined,
			}
		: undefined
	const current: LineageRow = {
		id: focused.id,
		title: focused.isSubagent ? focused.task : asideTitleOrTask(focused),
		status: statusFor(statuses, focused.id),
		access: focused.isSubagent ? (focused.subagentAccess ?? "read") : undefined,
		parentTaskId: parentId,
	}

	const saved = history.filter((item) => item.isSubagent && item.parentTaskId === focused.id).sort((a, b) => a.ts - b.ts)
	const children: LineageRow[] = saved.map((child) => ({
		id: child.id,
		title: child.task,
		status: statusFor(statuses, child.id),
		access: child.subagentAccess ?? "read",
		parentTaskId: focused.id,
	}))
	const ownMessages = focused.forkedAtTs ? messages.filter((message) => message.ts > (focused.forkedAtTs ?? 0)) : messages
	for (const subagent of collectSubagents(ownMessages)) {
		// A saved child already has a row. Match pre-lifecycle prompt rows by title only
		// to avoid a duplicate preview while the spawn tool is streaming its input.
		if (saved.some((child) => child.id === subagent.id || (subagent.previewOnly && child.task.trim() === subagent.title)))
			continue
		children.push({
			id: subagent.id,
			title: subagent.title,
			status: subagent.status,
			access: subagent.access,
			previewOnly: subagent.previewOnly,
			parentTaskId: focused.id,
		})
	}

	return { parent, current, children }
}

function asideTitleOrTask(item: HistoryItem): string {
	return item.parentTaskId ? asideTitle(item) : item.task
}

/** A child that needs the user (approval or question pending). */
export function needsAttention(row: LineageRow): boolean {
	return row.status === "waiting" && !row.previewOnly
}

/** A child that a Stop button can still end. */
export function isStoppable(row: LineageRow): boolean {
	return row.status === "running" || row.status === "waiting"
}
