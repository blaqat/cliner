import type { ClineMessage, SideThreadView, TurnPhase } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { StringArrayRequest } from "@shared/proto/cline/common"
import { sideThreadAnswer, sideThreadAnswerText, WRAP_UP_PROMPT } from "@shared/sideThreads"
import { useCallback, useEffect, useMemo, useState } from "react"
import { closeSideThread, sendSideThreadNote, sendToSideThread } from "@/components/chat/chat-view/utils/asideUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { SideThreadServiceClient } from "@/services/grpc-client"
import { markWrapUp, useSideThreadSlots } from "./sideThreadStore"

/** Keeps the host posting the own rows of the side threads shown for `threadId` (beside it, or its side question). */
export function useWatchedSideThreads(threadId: string | undefined): void {
	const { beside, question } = useSideThreadSlots()
	const ids = [threadId && beside[threadId], threadId && question[threadId]].filter((id): id is string => !!id)
	const key = ids.join("\n")
	useEffect(() => {
		SideThreadServiceClient.watchSideThreads(StringArrayRequest.create({ value: key ? key.split("\n") : [] })).catch(
			(error) => console.error("Failed to watch side threads:", error),
		)
	}, [key])
}

/** A watched side thread's own rows and phase, plus its saved record. */
export function useSideThreadView(id: string | undefined): {
	item?: HistoryItem
	view?: SideThreadView
} {
	const { sideThreadViews, taskHistory } = useExtensionState()
	return useMemo(
		() => ({
			item: id ? taskHistory?.find((entry) => entry.id === id) : undefined,
			view: id ? sideThreadViews?.find((entry) => entry.id === id) : undefined,
		}),
		[id, sideThreadViews, taskHistory],
	)
}

export function isPhaseRunning(phase: TurnPhase | undefined): boolean {
	return phase === "streaming" || phase === "awaiting_approval"
}

/** The last user message in a side thread's own rows. */
function lastUserText(messages: readonly ClineMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.type === "say" && (message.say === "user_feedback" || message.say === "task")) return message.text
	}
	return undefined
}

/**
 * Wrap up: asks the side thread (one model call the user clicked) for a short note to Main.
 * Its answer becomes a draft the user edits or approves; sending it closes the side thread.
 */
export function useWrapUp(sideId: string | undefined, messages: readonly ClineMessage[], phase: TurnPhase | undefined) {
	const { wrapUp } = useSideThreadSlots()
	const asked = !!sideId && !!wrapUp[sideId]
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const answer = sideThreadAnswer(messages)
	const ready = asked && lastUserText(messages)?.trim() === WRAP_UP_PROMPT && !!answer && !isPhaseRunning(phase)
	const draft = ready ? sideThreadAnswerText(answer) : ""

	const start = useCallback(async () => {
		if (!sideId) return
		setError(undefined)
		markWrapUp(sideId, true)
		try {
			await sendToSideThread(sideId, WRAP_UP_PROMPT)
		} catch (failure) {
			markWrapUp(sideId, false)
			setError(failure instanceof Error ? failure.message : String(failure))
		}
	}, [sideId])

	const send = useCallback(
		async (text: string) => {
			if (!sideId) return false
			setBusy(true)
			setError(undefined)
			try {
				await sendSideThreadNote(sideId, text)
				await closeSideThread(sideId)
				return true
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : String(failure))
				return false
			} finally {
				setBusy(false)
			}
		},
		[sideId],
	)

	const discard = useCallback(() => {
		if (sideId) markWrapUp(sideId, false)
	}, [sideId])

	return { asked, ready, draft, busy, error, start, send, discard, drafting: asked && !ready }
}
