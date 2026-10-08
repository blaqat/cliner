import type { ClineMessage } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { AskResponseRequest, ForkTaskAtRequest } from "@shared/proto/cline/task"
import { TaskServiceClient } from "@/services/grpc-client"

export interface AsideRequest {
	/** Task to fork. */
	taskId: string
	/** Conversation is copied through this message. */
	messageTs: number
	text?: string
	images?: string[]
	files?: string[]
}

/** The message an Alt+Enter aside forks from: the latest one in the transcript. */
export function latestMessageTs(messages: readonly ClineMessage[]): number | undefined {
	return messages.at(-1)?.ts
}

/**
 * Forks `taskId` at `messageTs` into an aside (opens in Ask), focuses it and,
 * when there is content, sends it as the aside's first prompt. The parent keeps
 * running in the background. Resolves with the aside's task id.
 */
export async function startAside({ taskId, messageTs, text = "", images = [], files = [] }: AsideRequest): Promise<string> {
	const { value: asideId } = await TaskServiceClient.forkTaskAt(ForkTaskAtRequest.create({ taskId, messageTs }))
	await TaskServiceClient.showTaskWithId(StringRequest.create({ value: asideId }))
	if (text.trim() || images.length > 0 || files.length > 0) {
		await TaskServiceClient.askResponse(
			AskResponseRequest.create({ responseType: "messageResponse", text: text.trim(), images, files }),
		)
	}
	return asideId
}
