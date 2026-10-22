import type {
	ClineAskUseSubagents,
	ClineMessage,
	ClineSaySubagentStatus,
	SubagentExecutionStatus,
} from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { SessionStatus, SessionStatuses } from "@/components/inbox/inboxUtils"
import {
	buildThreadStatuses,
	type ThreadStatus,
	type ThreadStatuses,
	threadStatusFor,
	threadStatusLabel,
} from "@/components/inbox/threadStatus"

export type ThreadKind = "main" | "aside" | "subagent"

export interface ThreadItem {
	kind: ThreadKind
	/** Task id for main/aside; `<statusMessageTs>:<index>` for subagents. */
	id: string
	title: string
	status: ThreadStatus
	/** Status tooltip when it says more than the status name ("Waiting on 2 subagents"). */
	statusLabel?: string
	/** True for the chip of the focused task. */
	current: boolean
	access?: "read" | "write"
	parentTaskId?: string
	/** Older transcripts without a saved child record retain their inline preview. */
	previewOnly?: boolean
	/** Thread strip only: 0 for Main, 1 for its asides, 2+ for asides of asides. */
	depth?: number
}

const SUBAGENT_STATUS: Record<SubagentExecutionStatus, SessionStatus> = {
	pending: "waiting",
	running: "running",
	completed: "done",
	failed: "error",
	stopped: "error",
}

const ASIDE_PREFIX = /^Aside:\s*/i

/** Derived status and its tooltip for a thread id. */
function statusFields(statuses: ThreadStatuses, id: string): { status: ThreadStatus; statusLabel?: string } {
	const statusLabel = threadStatusLabel(statuses[id])
	return { status: threadStatusFor(statuses, id), ...(statusLabel ? { statusLabel } : {}) }
}

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
 * Chips for the human-made threads of the focused chat: Main and its asides, at any depth.
 * Subagents live in the header's subagent panel instead. Returns [] when the chat has no asides,
 * or when a subagent thread is focused.
 *
 * Always rooted at the real Main (focusing an aside of an aside must not make its parent "Main"),
 * in tree order: each aside, oldest first, is followed by its own asides, with `depth` set so the
 * strip can group an aside with everything under it. A closed (hidden) aside drops with its
 * asides, unless the focused thread is among them.
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
	const byId = new Map(history.map((item) => [item.id, item]))
	byId.set(focused.id, byId.get(focused.id) ?? focused)
	// Walk up through asides to the thread that has no (known, human) parent.
	let root = focused
	const seen = new Set([root.id])
	for (let parent = root.parentTaskId ? byId.get(root.parentTaskId) : undefined; parent && !parent.isSubagent; ) {
		if (seen.has(parent.id)) break
		seen.add(parent.id)
		root = parent
		parent = root.parentTaskId ? byId.get(root.parentTaskId) : undefined
	}
	const children = new Map<string, HistoryItem[]>()
	for (const item of byId.values()) {
		if (item.isSubagent || !item.parentTaskId || item.id === root.id) continue
		const list = children.get(item.parentTaskId) ?? []
		list.push(item)
		children.set(item.parentTaskId, list)
	}
	const derived = buildThreadStatuses(history, statuses)
	const containsFocused = (id: string): boolean =>
		id === focused.id || (children.get(id) ?? []).some((child) => containsFocused(child.id))

	const items: ThreadItem[] = [
		{
			kind: "main",
			id: root.id,
			title: "Main",
			...statusFields(derived, root.id),
			current: root.id === focused.id,
			depth: 0,
		},
	]
	const visit = (parentId: string, depth: number, trail: Set<string>) => {
		for (const aside of [...(children.get(parentId) ?? [])].sort((a, b) => a.ts - b.ts)) {
			if (trail.has(aside.id)) continue
			if (hiddenIds.has(aside.id) && !containsFocused(aside.id)) continue
			items.push({
				kind: "aside",
				id: aside.id,
				title: asideTitle(aside),
				...statusFields(derived, aside.id),
				current: aside.id === focused.id,
				depth,
			})
			visit(aside.id, depth + 1, new Set(trail).add(aside.id))
		}
	}
	visit(root.id, 1, new Set([root.id]))
	return items.length > 1 ? items : []
}

export function asideTitle(item: HistoryItem): string {
	return item.title?.trim() || item.task.replace(ASIDE_PREFIX, "") || "Aside"
}

/** Display name for any thread: the user-set title, else its first message (asides drop their prefix). */
export function threadTitle(item: HistoryItem): string {
	return item.title?.trim() || (item.isSubagent ? item.task : asideTitleOrTask(item))
}

export interface ThreadPathItem {
	id: string
	title: string
	/** Aside or subagent, shown with a `↳` prefix. */
	sub: boolean
}

export interface ThreadPath {
	/**
	 * Task (group) the focused thread belongs to. Main threads and asides own their
	 * membership; subagents take it from the nearest non-subagent above them.
	 */
	taskGroupId?: string
	/** Root first, ending with the focused thread. */
	threads: ThreadPathItem[]
}

/**
 * Every level above the focused thread, walking `parentTaskId` through asides
 * and subagents up to the root. A parent missing from the (possibly lagging)
 * history still gets a placeholder level, and the walk stops there.
 */
export function buildThreadPath(focused: HistoryItem | undefined, history: readonly HistoryItem[]): ThreadPath {
	if (!focused) {
		return { threads: [] }
	}
	const byId = new Map(history.map((item) => [item.id, item]))
	const threads: ThreadPathItem[] = [{ id: focused.id, title: threadTitle(focused), sub: !!focused.parentTaskId }]
	let taskGroupId = focused.taskGroupId
	// Membership is settled once a non-subagent thread is reached.
	let owned = !focused.isSubagent
	let node = focused
	const seen = new Set([focused.id])
	while (node.parentTaskId && !seen.has(node.parentTaskId)) {
		const parent = byId.get(node.parentTaskId)
		if (!parent) {
			threads.unshift({ id: node.parentTaskId, title: "Parent", sub: false })
			break
		}
		seen.add(parent.id)
		threads.unshift({ id: parent.id, title: threadTitle(parent), sub: !!parent.parentTaskId })
		if (!owned) {
			taskGroupId = parent.taskGroupId ?? taskGroupId
			owned = !parent.isSubagent
		}
		node = parent
	}
	return { taskGroupId: taskGroupId || undefined, threads }
}

export interface LineageRow {
	/** Task id; `<statusMessageTs>:<index>` for an unsaved transcript preview. */
	id: string
	title: string
	status: ThreadStatus
	/** Status tooltip when it says more than the status name ("Waiting on 2 subagents"). */
	statusLabel?: string
	access?: "read" | "write"
	/** Older transcripts without a saved child record; opens by scrolling to its status row. */
	previewOnly?: boolean
	/** Task that spawned this row (the id to pass to stopSubagent). */
	parentTaskId?: string
	toolCalls?: number
	tokens?: number
	cost?: number
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
	const derived = buildThreadStatuses(history, statuses)
	const parent: LineageRow | undefined = parentId
		? {
				id: parentId,
				title: parentItem ? (parentItem.isSubagent ? parentItem.task : asideTitleOrTask(parentItem)) : "Parent",
				...statusFields(derived, parentId),
				access: parentItem?.isSubagent ? (parentItem.subagentAccess ?? "read") : undefined,
			}
		: undefined
	const current: LineageRow = {
		id: focused.id,
		title: focused.isSubagent ? focused.task : asideTitleOrTask(focused),
		...statusFields(derived, focused.id),
		access: focused.isSubagent ? (focused.subagentAccess ?? "read") : undefined,
		parentTaskId: parentId,
	}

	const saved = history.filter((item) => item.isSubagent && item.parentTaskId === focused.id).sort((a, b) => a.ts - b.ts)
	const children: LineageRow[] = saved.map((child) => ({
		id: child.id,
		title: child.task,
		...statusFields(derived, child.id),
		access: child.subagentAccess ?? "read",
		parentTaskId: focused.id,
		toolCalls: child.subagentToolCalls,
		tokens: child.tokensIn + child.tokensOut + (child.cacheReads ?? 0) + (child.cacheWrites ?? 0),
		cost: child.totalCost,
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
	return item.parentTaskId ? asideTitle(item) : item.title?.trim() || item.task
}

/** A child that needs the user (approval or question pending). */
export function needsAttention(row: LineageRow): boolean {
	return row.status === "waiting" && !row.previewOnly
}

/** A child that a Stop button can still end. */
export function isStoppable(row: LineageRow): boolean {
	return row.status === "running" || row.status === "waiting"
}
