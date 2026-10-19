import type { HistoryItem } from "@shared/HistoryItem"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type SessionStatuses, statusFor } from "@/components/inbox/inboxUtils"
import { toggleTaskSettled } from "@/components/inbox/sessionActions"
import { useExtensionState } from "@/context/ExtensionStateContext"

/** What "Settle all" / "Unsettle all" would do to a task's threads right now. */
export interface SettleAllPlan {
	mode: "settle" | "unsettle"
	/** Threads the action flips (unsettled ones for settle, settled ones for unsettle). */
	targets: string[]
	/** Threads settle skips because they are working or waiting: a live session never shows as settled. */
	running: number
	/** Threads already settled (settle mode only; they stay as they are). */
	alreadySettled: number
	total: number
}

const isLive = (status: string) => status === "running" || status === "waiting"

/**
 * Plans a bulk settle for the threads filed in `taskGroupId` (subagents belong to their parent
 * thread, so they are not counted). Every thread settled -> the action becomes "Unsettle all", like
 * the per-thread toggle. Running threads are skipped, matching the inbox which never shows a live
 * session as settled.
 */
export function planSettleAll(
	taskGroupId: string,
	history: readonly HistoryItem[],
	statuses: SessionStatuses | undefined,
): SettleAllPlan {
	const threads = history.filter((item) => item.taskGroupId === taskGroupId && !item.isSubagent)
	const settled = threads.filter((item) => item.isSettled)
	if (threads.length > 0 && settled.length === threads.length) {
		return { mode: "unsettle", targets: settled.map((item) => item.id), running: 0, alreadySettled: 0, total: threads.length }
	}
	const open = threads.filter((item) => !item.isSettled)
	const running = open.filter((item) => isLive(statusFor(statuses, item.id)))
	return {
		mode: "settle",
		targets: open.filter((item) => !running.includes(item)).map((item) => item.id),
		running: running.length,
		alreadySettled: settled.length,
		total: threads.length,
	}
}

/** The inline result line: "Settled 4 · 1 still running". */
export function settleAllMessage(mode: SettleAllPlan["mode"], count: number, running: number): string {
	const parts = [`${mode === "settle" ? "Settled" : "Unsettled"} ${count}`]
	if (running > 0) parts.push(`${running} still running`)
	return parts.join(" · ")
}

const NOTICE_MS = 6000

/** Settle all / Unsettle all for one task, with the plan and the inline result message. */
export function useSettleAll(taskGroupId: string) {
	const { taskHistory, sessionStatuses } = useExtensionState()
	const plan = useMemo(
		() => planSettleAll(taskGroupId, taskHistory ?? [], sessionStatuses),
		[taskGroupId, taskHistory, sessionStatuses],
	)
	const [message, setMessage] = useState<{ text: string; partial: boolean }>()
	const timer = useRef<ReturnType<typeof setTimeout>>()
	useEffect(() => () => clearTimeout(timer.current), [])

	const dismiss = useCallback(() => {
		clearTimeout(timer.current)
		setMessage(undefined)
	}, [])

	const run = useCallback(async () => {
		const { mode, targets, running } = plan
		// One at a time: each toggle rewrites the history store.
		for (const id of targets) await toggleTaskSettled(id)
		setMessage({ text: settleAllMessage(mode, targets.length, running), partial: running > 0 })
		clearTimeout(timer.current)
		timer.current = setTimeout(() => setMessage(undefined), NOTICE_MS)
	}, [plan])

	return { plan, message, run, dismiss, disabled: plan.total === 0 }
}
