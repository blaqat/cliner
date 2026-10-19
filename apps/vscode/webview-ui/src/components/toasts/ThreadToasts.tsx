import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary } from "@shared/task-groups"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { threadTitle } from "@/components/chat/chat-view/utils/threadUtils"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { openTask } from "@/components/inbox/sessionActions"
import { buildThreadStatuses, type ThreadStatusMap, threadStatusMap } from "@/components/inbox/threadStatus"
import { useNavigationHistory } from "@/components/navigation/NavigationHistoryContext"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import {
	addThreadToasts,
	pruneThreadToasts,
	recentlyStoppedIds,
	type ThreadToast,
	threadToastDurationMs,
	threadToastEvents,
} from "./threadToastRules"

/**
 * Runs `onExpire` after `durationMs` of running time. Pausing (hover, or VS Code
 * in the background) keeps what's left; null never expires.
 */
export function useToastCountdown(durationMs: number | null, running: boolean, onExpire: () => void): void {
	const remainingRef = useRef(durationMs)
	const onExpireRef = useRef(onExpire)
	onExpireRef.current = onExpire
	useEffect(() => {
		remainingRef.current = durationMs
	}, [durationMs])
	useEffect(() => {
		const remaining = remainingRef.current
		if (remaining === null || !running) return
		const startedAt = Date.now()
		const timer = setTimeout(() => onExpireRef.current(), Math.max(0, remaining))
		return () => {
			clearTimeout(timer)
			remainingRef.current = remaining - (Date.now() - startedAt)
		}
	}, [running, durationMs])
}

interface ThreadToastCardProps {
	toast: ThreadToast
	title: string
	taskTitle?: string
	durationMs: number | null
	windowFocused: boolean
	onOpen: () => void
	onClose: () => void
}

export const ThreadToastCard = ({
	toast,
	title,
	taskTitle,
	durationMs,
	windowFocused,
	onOpen,
	onClose,
}: ThreadToastCardProps) => {
	const [hovered, setHovered] = useState(false)
	const running = windowFocused && !hovered
	useToastCountdown(durationMs, running, onClose)
	const input = toast.kind === "input"
	const subagent = toast.sourceId !== toast.threadId
	const status = input ? (subagent ? "A subagent needs input" : "Needs input") : "Finished"

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover only pauses the timer
		<div
			className="pointer-events-auto overflow-hidden rounded-md border border-(--vscode-notifications-border,var(--vscode-editorWidget-border)) bg-(--vscode-notifications-background,var(--vscode-editorWidget-background)) text-(--vscode-notifications-foreground,var(--vscode-foreground)) shadow-[0_6px_18px_var(--vscode-widget-shadow)] animate-[toast-in_0.15s_ease-out] motion-reduce:animate-none"
			data-kind={toast.kind}
			data-testid="thread-toast"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			role="status">
			<div className="flex items-start gap-2 py-2 pr-1.5 pl-2.5">
				<span
					aria-hidden
					className={cn(
						"codicon mt-0.5 shrink-0 text-[13px]",
						input ? "codicon-bell-dot text-warning" : "codicon-pass-filled text-success",
					)}
				/>
				<div className="min-w-0 flex-1 text-[12px]">
					<div className="ph-no-capture truncate" title={title}>
						{title}
					</div>
					<div className="truncate text-[11px] text-description">
						{status}
						{taskTitle && <span className="ph-no-capture"> · {taskTitle}</span>}
					</div>
				</div>
				<Button className="shrink-0 px-2 py-0.5" data-testid="thread-toast-open" onClick={onOpen} size="xs">
					{input ? "Review" : "Open"}
				</Button>
				<HeaderIconButton data-testid="thread-toast-close" icon="close" label="Dismiss" onClick={onClose} />
			</div>
			{durationMs !== null && (
				<div
					aria-hidden
					className="h-0.5 origin-left bg-(--vscode-progressBar-background)"
					style={{
						animation: `toast-countdown ${durationMs}ms linear forwards`,
						animationPlayState: running ? "running" : "paused",
					}}
				/>
			)}
		</div>
	)
}

function toastLabels(
	toast: ThreadToast,
	history: readonly HistoryItem[],
	taskGroups: readonly TaskGroupSummary[],
): { title: string; taskTitle?: string } {
	const item = history.find((entry) => entry.id === toast.threadId)
	const title = item ? threadTitle(item).replace(/\s+/g, " ").trim() : ""
	const taskTitle = item?.taskGroupId ? taskGroups.find((group) => group.id === item.taskGroupId)?.title : undefined
	return { title: title || "Thread", taskTitle }
}

/**
 * Toasts for background threads that finish or need input, stacked under the
 * header (newest on top, at most three). They never take focus or block input:
 * the layer ignores the pointer except on the cards themselves.
 */
export const ThreadToasts = () => {
	const {
		sessionStatuses,
		taskHistory,
		taskGroups,
		currentTaskItem,
		windowFocused,
		threadToastsEnabled,
		threadToastSeconds,
		didHydrateState,
		navigateToChat,
	} = useExtensionState()
	const navigation = useNavigationHistory()
	const current = navigation?.current
	// The thread on screen; any other view (home, a task page, settings) watches none.
	const viewingThreadId = navigation ? (current?.kind === "thread" ? current.id : undefined) : currentTaskItem?.id
	const enabled = threadToastsEnabled !== false
	const [toasts, setToasts] = useState<ThreadToast[]>([])
	const previousRef = useRef<ThreadStatusMap>()
	const idRef = useRef(0)
	const history = taskHistory ?? []
	const historyRef = useRef(history)
	historyRef.current = history

	useEffect(() => {
		if (!didHydrateState) return
		// Derived statuses: a thread idle only because its subagents still run is
		// "subagents", so it toasts "finished" when they are done, not before.
		const statuses = threadStatusMap(buildThreadStatuses(historyRef.current, sessionStatuses))
		const previous = previousRef.current
		previousRef.current = statuses
		if (!enabled) return
		const events = threadToastEvents(previous, statuses, {
			viewingThreadId,
			history: historyRef.current,
			stoppedIds: recentlyStoppedIds(),
		})
		setToasts((existing) => {
			const pruned = pruneThreadToasts(existing, statuses, viewingThreadId)
			return events.length ? addThreadToasts(pruned, events, () => ++idRef.current) : pruned
		})
	}, [sessionStatuses, viewingThreadId, enabled, didHydrateState])

	useEffect(() => {
		if (!enabled) setToasts([])
	}, [enabled])

	const dismiss = useCallback((id: number) => setToasts((existing) => existing.filter((toast) => toast.id !== id)), [])
	const open = useCallback(
		(toast: ThreadToast) => {
			dismiss(toast.id)
			if (navigation) {
				navigation.navigate({ kind: "thread", id: toast.threadId })
			} else {
				navigateToChat()
				void openTask(toast.threadId)
			}
		},
		[dismiss, navigation, navigateToChat],
	)

	const labels = useMemo(
		() => new Map(toasts.map((toast) => [toast.id, toastLabels(toast, history, taskGroups ?? [])])),
		[toasts, history, taskGroups],
	)

	if (!toasts.length) return null
	return (
		<div
			aria-live="polite"
			className="pointer-events-none absolute inset-x-2 top-10 z-40 flex flex-col gap-1.5"
			data-testid="thread-toasts">
			{toasts.map((toast) => {
				const label = labels.get(toast.id)
				return (
					<ThreadToastCard
						durationMs={threadToastDurationMs(toast.kind, threadToastSeconds)}
						key={toast.id}
						onClose={() => dismiss(toast.id)}
						onOpen={() => open(toast)}
						taskTitle={label?.taskTitle}
						title={label?.title ?? "Thread"}
						toast={toast}
						windowFocused={windowFocused}
					/>
				)
			})}
		</div>
	)
}
