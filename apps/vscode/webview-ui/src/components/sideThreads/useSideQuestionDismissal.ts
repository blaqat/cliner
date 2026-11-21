import type { ClineMessage } from "@shared/ExtensionMessage"
import { useEffect, useRef } from "react"
import { dismissSideQuestion } from "@/components/chat/chat-view/utils/asideUtils"
import { useSideThreadSlots } from "./sideThreadStore"

/** No timeout: an answer stays readable until the user sends, asks again or leaves. */
export function useSideQuestionDismissal(threadId: string | undefined, messages: readonly ClineMessage[]): void {
	const { question } = useSideThreadSlots()
	const previous = useRef<{ threadId?: string; questionId?: string; userTs: number } | undefined>(undefined)
	const userTs = messages.reduce(
		(latest, message) =>
			message.type === "say" && (message.say === "task" || message.say === "user_feedback")
				? Math.max(latest, message.ts)
				: latest,
		0,
	)
	useEffect(() => {
		const last = previous.current
		const questionId = threadId ? question[threadId] : undefined
		previous.current = { threadId, questionId, userTs }

		if (last?.threadId && last.threadId !== threadId) void dismissSideQuestion(last.threadId)
		if (threadId && last?.threadId === threadId && last.questionId === questionId && userTs > last.userTs) {
			void dismissSideQuestion(threadId)
		}
	}, [threadId, question, userTs])
}
