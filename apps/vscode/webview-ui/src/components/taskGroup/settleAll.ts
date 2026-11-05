import type { HistoryItem } from "@shared/HistoryItem"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type SessionStatuses, statusFor } from "@/components/inbox/inboxUtils"
import { toggleTaskSettled, toggleTaskStashed } from "@/components/inbox/sessionActions"
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

/** What a task row's Stash / Unstash would do to its threads right now. */
export interface StashAllPlan {
	mode: "stash" | "unstash"
	/** Threads the action flips (unstashed ones for stash, every thread for unstash). */
	targets: string[]
	total: number
}

/**
 * Plans stashing a whole task: the same threads as {@link planSettleAll} (asides included, subagents
 * not), so the inbox's "every thread stashed" test for the task row agrees with it. Every thread
 * stashed -> "Unstash" brings them all back. Stashing a thread clears its settled flag (and settling
 * clears stashed), so a task moves between Stashed and Settled whole.
 */
export function planStashAll(taskGroupId: string, history: readonly HistoryItem[]): StashAllPlan {
	const threads = history.filter((item) => item.taskGroupId === taskGroupId && !item.isSubagent)
	const stashed = threads.filter((item) => item.isStashed)
	if (threads.length > 0 && stashed.length === threads.length) {
		return { mode: "unstash", targets: stashed.map((item) => item.id), total: threads.length }
	}
	return { mode: "stash", targets: threads.filter((item) => !item.isStashed).map((item) => item.id), total: threads.length }
}

export function stashAllMessage(mode: StashAllPlan["mode"], count: number): string {
	return `${mode === "stash" ? "Stashed" : "Unstashed"} ${count}`
}

const NOTICE_MS = 6000

/** The inline result line after a bulk action, cleared after a few seconds. */
function useBulkNotice() {
	const [message, setMessage] = useState<{ text: string; partial: boolean }>()
	const timer = useRef<ReturnType<typeof setTimeout>>()
	useEffect(() => () => clearTimeout(timer.current), [])
	const dismiss = useCallback(() => {
		clearTimeout(timer.current)
		setMessage(undefined)
	}, [])
	const show = useCallback((text: string, partial: boolean) => {
		setMessage({ text, partial })
		clearTimeout(timer.current)
		timer.current = setTimeout(() => setMessage(undefined), NOTICE_MS)
	}, [])
	return { message, dismiss, show }
}

/** Settle all / Unsettle all for one task, with the plan and the inline result message. */
export function useSettleAll(taskGroupId: string) {
	const { taskHistory, sessionStatuses } = useExtensionState()
	const plan = useMemo(
		() => planSettleAll(taskGroupId, taskHistory ?? [], sessionStatuses),
		[taskGroupId, taskHistory, sessionStatuses],
	)
	const { message, dismiss, show } = useBulkNotice()

	const run = useCallback(async () => {
		const { mode, targets, running } = plan
		// One at a time: each toggle rewrites the history store.
		for (const id of targets) await toggleTaskSettled(id)
		show(settleAllMessage(mode, targets.length, running), running > 0)
	}, [plan, show])

	return { plan, message, run, dismiss, disabled: plan.total === 0 }
}

/**
 * A task row's Stash and Settle: each acts on every thread in the task (there is no task-level
 * flag; the row's section follows its threads), sharing one inline result line.
 */
export function useTaskRowActions(taskGroupId: string) {
	const { taskHistory } = useExtensionState()
	const settle = useSettleAll(taskGroupId)
	const stashPlan = useMemo(() => planStashAll(taskGroupId, taskHistory ?? []), [taskGroupId, taskHistory])
	const notice = useBulkNotice()
	const runStash = useCallback(async () => {
		settle.dismiss()
		for (const id of stashPlan.targets) await toggleTaskStashed(id)
		notice.show(stashAllMessage(stashPlan.mode, stashPlan.targets.length), false)
	}, [stashPlan, notice.show, settle.dismiss])
	const runSettle = useCallback(async () => {
		notice.dismiss()
		await settle.run()
	}, [settle.run, notice.dismiss])
	return {
		settle: { plan: settle.plan, run: runSettle, disabled: settle.disabled },
		stash: { plan: stashPlan, run: runStash, disabled: stashPlan.total === 0 },
		message: settle.message ?? notice.message,
		dismiss: () => {
			settle.dismiss()
			notice.dismiss()
		},
	}
}
