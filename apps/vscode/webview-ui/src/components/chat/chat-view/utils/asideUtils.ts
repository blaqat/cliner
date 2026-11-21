import type { ClineMessage } from "@shared/ExtensionMessage"
import { type ComposerProvenance, StringRequest } from "@shared/proto/cline/common"
import {
	SendSideThreadNoteRequest,
	SendToSideThreadRequest,
	StartSideThreadRequest,
	UpdateSideThreadRequest,
} from "@shared/proto/cline/side_thread"
import { AskResponseRequest } from "@shared/proto/cline/task"
import type { SideThreadKind } from "@shared/sideThreads"
import {
	clearBeside,
	clearQuestion,
	forgetSideThread,
	getSideThreadSlots,
	showBeside,
	showQuestion,
} from "@/components/sideThreads/sideThreadStore"
import { SideThreadServiceClient, TaskServiceClient } from "@/services/grpc-client"

export interface AsideRequest {
	/** Task to fork. */
	taskId: string
	/** Conversation is copied through this message. */
	messageTs: number
	text?: string
	images?: string[]
	files?: string[]
	/** What the user explicitly picked or ran in the composer for `text`. */
	provenance?: ComposerProvenance
}

/** The message an Alt+Enter side thread forks from: the latest one in the transcript. */
export function latestMessageTs(messages: readonly ClineMessage[]): number | undefined {
	return messages.at(-1)?.ts
}

function startRequest(request: AsideRequest, kind: SideThreadKind, background: boolean) {
	return StartSideThreadRequest.create({
		taskId: request.taskId,
		messageTs: request.messageTs,
		kind,
		text: request.text?.trim() ?? "",
		images: request.images ?? [],
		files: request.files ?? [],
		provenance: request.provenance,
		background,
	})
}

/**
 * Forks `taskId` at `messageTs` into a side thread (opens in Ask), focuses it and,
 * when there is content, sends it as the side thread's first prompt. Main keeps
 * running in the background. Resolves with the side thread's id.
 */
export async function startAside({ text = "", images = [], files = [], ...request }: AsideRequest): Promise<string> {
	const { value: asideId } = await SideThreadServiceClient.startSideThread(
		startRequest({ ...request, text: "" }, "side", false),
	)
	await TaskServiceClient.showTaskWithId(StringRequest.create({ value: asideId }))
	if (text.trim() || images.length > 0 || files.length > 0) {
		await TaskServiceClient.askResponse(
			AskResponseRequest.create({
				responseType: "messageResponse",
				text: text.trim(),
				images,
				files,
				provenance: request.provenance,
			}),
		)
	}
	return asideId
}

/**
 * /side, Alt+Enter and "Side thread from here": beside Main in the panel column when
 * there's room (Main stays on screen), else as its own view (today's behavior).
 */
export async function startSideThread(request: AsideRequest): Promise<string> {
	if (!getSideThreadSlots().room) return startAside(request)
	const { value: sideId } = await SideThreadServiceClient.startSideThread(startRequest(request, "side", true))
	showBeside(request.taskId, sideId)
	return sideId
}

const pendingQuestions = new Map<string, symbol>()

/** /btw: a side question answered in a card above the composer. Main is never interrupted. */
export async function startSideQuestion(request: AsideRequest): Promise<string> {
	const { taskId } = request
	void dismissSideQuestion(taskId)
	const pending = Symbol()
	pendingQuestions.set(taskId, pending)
	try {
		const { value: questionId } = await SideThreadServiceClient.startSideThread(startRequest(request, "btw", true))
		if (pendingQuestions.get(taskId) === pending) showQuestion(taskId, questionId)
		else await closeDismissedQuestion(questionId)
		return questionId
	} finally {
		if (pendingQuestions.get(taskId) === pending) pendingQuestions.delete(taskId)
	}
}

/** Opens an existing side thread beside Main when there's room, else as its own view. */
export function openSideThread(mainId: string, sideId: string): void {
	if (getSideThreadSlots().room) {
		showBeside(mainId, sideId)
		return
	}
	void TaskServiceClient.showTaskWithId(StringRequest.create({ value: sideId })).catch((error) =>
		console.error("Failed to open side thread:", error),
	)
}

export async function sendToSideThread(threadId: string, text: string, provenance?: ComposerProvenance): Promise<void> {
	await SideThreadServiceClient.sendToSideThread(
		SendToSideThreadRequest.create({ threadId, text, images: [], files: [], provenance }),
	)
}

/** Sends a note the user approved to the side thread's main thread. */
export async function sendSideThreadNote(threadId: string, text: string): Promise<void> {
	await SideThreadServiceClient.sendSideThreadNote(SendSideThreadNoteRequest.create({ threadId, text }))
}

/** Keeps a side question as a side thread and opens it. */
export async function keepSideQuestion(threadId: string, questionId: string): Promise<void> {
	await SideThreadServiceClient.updateSideThread(UpdateSideThreadRequest.create({ threadId: questionId, kind: "side" }))
	clearQuestion(threadId)
	openSideThread(threadId, questionId)
}

/** Closes a side thread or side question (stopping it if it runs). It stays listed under Main. */
export async function closeSideThread(sideId: string): Promise<void> {
	forgetSideThread(sideId)
	await SideThreadServiceClient.updateSideThread(UpdateSideThreadRequest.create({ threadId: sideId, closed: true }))
}

/** Reopens a closed side thread: listed as open again. */
export async function reopenSideThread(sideId: string): Promise<void> {
	await SideThreadServiceClient.updateSideThread(UpdateSideThreadRequest.create({ threadId: sideId, closed: false }))
}

export { clearBeside }

/** Dismisses the quick card on the user's next action, stopping its answer if needed. */
export async function dismissSideQuestion(threadId: string): Promise<void> {
	pendingQuestions.delete(threadId)
	const questionId = getSideThreadSlots().question[threadId]
	if (questionId) await closeDismissedQuestion(questionId)
}

async function closeDismissedQuestion(questionId: string): Promise<void> {
	try {
		await closeSideThread(questionId)
	} catch (error) {
		console.error("Failed to close side question:", error)
	}
}
