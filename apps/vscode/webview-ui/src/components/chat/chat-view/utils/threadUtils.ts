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
 * Chips for the focused thread, its immediate parent, siblings, and direct
 * children. Returns [] when there is nothing but Main.
 */
export function buildThreadItems(
	focused: HistoryItem | undefined,
	history: readonly HistoryItem[],
	statuses: SessionStatuses | undefined,
	messages: readonly ClineMessage[],
	hiddenIds: ReadonlySet<string> = new Set(),
): ThreadItem[] {
	if (!focused) {
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
			title: aside.task.replace(ASIDE_PREFIX, "") || "Aside",
			status: statusFor(statuses, aside.id),
			current: aside.id === focused.id,
		})
	}
	// An aside that is not yet in the (possibly lagging) history list still gets a chip.
	if (!focused.isSubagent && focused.id !== root.id && !asides.some((aside) => aside.id === focused.id)) {
		items.push({
			kind: "aside",
			id: focused.id,
			title: focused.task.replace(ASIDE_PREFIX, "") || "Aside",
			status: statusFor(statuses, focused.id),
			current: true,
		})
	}

	const children = history.filter(
		(item) => item.isSubagent && (item.parentTaskId === root.id || item.parentTaskId === focused.id),
	)
	if (focused.isSubagent && !children.some((item) => item.id === focused.id)) children.push(focused)
	for (const child of children.sort((a, b) => a.ts - b.ts)) {
		if (hiddenIds.has(child.id) && child.id !== focused.id) continue
		items.push({
			kind: "subagent",
			id: child.id,
			title: child.task,
			status: statusFor(statuses, child.id),
			current: child.id === focused.id,
			access: child.subagentAccess ?? "read",
			parentTaskId: child.parentTaskId,
		})
	}
	const ownMessages = focused.forkedAtTs ? messages.filter((message) => message.ts > (focused.forkedAtTs ?? 0)) : messages
	for (const subagent of collectSubagents(ownMessages)) {
		// A saved child already has a chip. Match pre-lifecycle prompt rows by title only
		// to avoid a duplicate preview while the spawn tool is streaming its input.
		if (
			children.some(
				(child) =>
					child.parentTaskId === focused.id &&
					(child.id === subagent.id || (subagent.previewOnly && child.task.trim() === subagent.title)),
			)
		)
			continue
		if (!hiddenIds.has(subagent.id)) items.push({ ...subagent, parentTaskId: focused.id })
	}

	return items.length > 1 ? items : []
}
