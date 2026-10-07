import type { ConsecutiveMistakeLimitContext, ConsecutiveMistakeLimitDecision } from "@cline/shared"
import type { ClineAskQuestion, ClineMessage, TurnPhase } from "@shared/ExtensionMessage"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import { Logger } from "@/shared/services/Logger"
import { MessageIdMinter } from "./message-id-minter"
import { buildToolApprovalAskMessage } from "./message-translator"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { buildToolApprovalDenialReason } from "./tool-approval-denial"

export interface ToolApprovalRequest {
	signal?: AbortSignal
	agentId: string
	conversationId: string
	iteration: number
	toolCallId: string
	toolName: string
	input: unknown
	policy: { enabled?: boolean; autoApprove?: boolean; requireApproval?: boolean }
}

export interface SdkInteractionCoordinatorOptions {
	messages: SdkMessageCoordinator
	onDecisionMessage?: (agentId: string | undefined, message: ClineMessage) => void
	getSessionId: () => string
	postStateToWebview: () => Promise<void>
	getMode?: () => "plan" | "act"
	shouldAutoApproveTool?: (request: ToolApprovalRequest) => boolean
	recordApprovedToolMessage?: (toolCallId: string, messageTs: number) => void
	recordDeniedToolApproval?: (toolCallId: string, toolName: string, reason: string) => void
	/**
	 * The process-wide id/seq/epoch authority, shared with the message translator. Optional so
	 * existing tests that don't need cross-generator id uniqueness keep working; when omitted a
	 * private minter is used. Production wires the shared minter from MessageTranslatorState.
	 */
	getMinter?: () => MessageIdMinter
	/**
	 * Set the authoritative UI turn phase. Called when an approval/ask is pending
	 * (awaiting_approval / awaiting_followup) and when the user responds (back to streaming).
	 * Optional for tests.
	 */
	setTurnPhase?: (phase: TurnPhase, anchorTs?: number) => void
	/**
	 * Invoked for manually-approved tools after the auto-approve short-circuit, BEFORE the
	 * ask message is emitted. Used to open the edit diff preview so the user decides while
	 * looking at the actual change. Must not throw; failures fall back to a plain ask.
	 */
	onToolApprovalAsk?: (request: ToolApprovalRequest) => Promise<void>
	/**
	 * The task's working directory, used to relativize the absolute filesystem paths
	 * shown in tool-approval asks (display only). Optional for tests.
	 */
	getCwd?: () => string | undefined
}

type ApprovalResolver = (result: { approved: boolean; reason?: string }) => void

export class SdkInteractionCoordinator {
	private pendingQuestions = new Map<
		string,
		{
			id: string
			agentId?: string
			message: ClineMessage
			resolve: (answer: string) => void
		}
	>()
	private preparingApproval: { request: ToolApprovalRequest; resolve: ApprovalResolver } | undefined
	private pendingApproval:
		| { id: string; request: ToolApprovalRequest; message: ClineMessage; resolve: ApprovalResolver }
		| undefined
	private toolApprovalQueue: { request: ToolApprovalRequest; resolve: ApprovalResolver }[] = []

	getPendingDecision(agentId?: string): { id: string; message: ClineMessage; kind: "approval" | "question" } | undefined {
		const approval = this.pendingApproval
		if (approval && (agentId === undefined || approval.request.agentId === agentId))
			return { id: approval.id, message: approval.message, kind: "approval" }
		const question = [...this.pendingQuestions.values()]
			.reverse()
			.find((pending) => agentId === undefined || pending.agentId === agentId)
		return question ? { id: question.id, message: question.message, kind: "question" } : undefined
	}

	hasPendingDecision(id: string): boolean {
		return this.pendingApproval?.id === id || this.pendingQuestions.has(id)
	}

	private updateTurnPhase(): void {
		const decision = this.getPendingDecision()
		this.options.setTurnPhase?.(
			decision ? (decision.kind === "approval" ? "awaiting_approval" : "awaiting_followup") : "streaming",
			decision?.message.ts,
		)
	}

	constructor(private readonly options: SdkInteractionCoordinatorOptions) {}

	/**
	 * CLI-parity mistake-limit handling: show an error row and stop the run
	 * immediately. The session stays resumable, so the user continues
	 * whenever they want by sending a new message (which also resets the
	 * SDK's mistake tracking). A blocking ask here would leave the agent
	 * loop running against the provider while the prompt sits unanswered.
	 */
	async handleConsecutiveMistakeLimitReached(
		context: ConsecutiveMistakeLimitContext,
	): Promise<ConsecutiveMistakeLimitDecision> {
		const detail = context.details?.trim()
		const latest = detail ? `${context.reason}: ${detail}` : `${context.reason} at iteration ${context.iteration}`
		const errorMessage: ClineMessage = {
			ts: this.nextMessageTs(),
			type: "say",
			say: "error",
			text: `Cline ran into ${context.consecutiveMistakes} errors in a row and stopped the task.\n\nLatest: ${latest}\n\nSend a message to give Cline guidance and continue the task.`,
			partial: false,
		}

		this.options.messages.appendAndEmit([errorMessage], {
			type: "status",
			payload: { sessionId: this.options.getSessionId(), status: "running" },
		})
		await this.options.postStateToWebview()

		return { action: "stop", reason: `mistake_limit_reached: ${latest}` }
	}

	async handleRequestToolApproval(request: ToolApprovalRequest): Promise<{ approved: boolean; reason?: string }> {
		if (request.signal?.aborted) return { approved: false, reason: "Agent run aborted" }
		if (
			request.policy.requireApproval !== true &&
			(request.policy.autoApprove === true || this.options.shouldAutoApproveTool?.(request) === true)
		) {
			Logger.log(`[SdkController] Auto-approving tool execution: tool=${request.toolName}`)
			return { approved: true }
		}

		return new Promise((resolve) => {
			const settle = (result: { approved: boolean; reason?: string }) => {
				request.signal?.removeEventListener("abort", onAbort)
				resolve(result)
			}
			const onAbort = () => {
				this.clearPending("Agent run aborted", request.agentId, settle)
			}

			request.signal?.addEventListener("abort", onAbort, { once: true })
			this.toolApprovalQueue.push({ request, resolve: settle })
			if (request.signal?.aborted) onAbort()
			else if (!this.pendingApproval && !this.preparingApproval) void this.showNextToolApproval()
		})
	}

	private async showNextToolApproval(): Promise<void> {
		const pending = this.toolApprovalQueue.shift()
		if (!pending) return
		const { request, resolve } = pending
		this.pendingApproval = undefined
		this.preparingApproval = pending
		// Reserve the active slot before awaiting the preview. Concurrent children queue behind it.
		try {
			await this.options.onToolApprovalAsk?.(request)
		} catch (error) {
			Logger.warn(`[SdkController] onToolApprovalAsk failed; showing plain approval ask: ${error}`)
		}
		if (this.preparingApproval !== pending) return
		const toolAskMessage = buildToolApprovalAskMessage(
			request.toolName,
			request.input,
			this.nextMessageTs(),
			this.options.getCwd?.(),
		)
		const id = String(toolAskMessage.ts)
		toolAskMessage.decisionId = id
		this.pendingApproval = { id, request, message: toolAskMessage, resolve }
		this.preparingApproval = undefined
		this.options.onDecisionMessage?.(request.agentId, toolAskMessage)

		this.options.messages.appendAndEmit([toolAskMessage], {
			type: "status",
			payload: { sessionId: this.options.getSessionId(), status: "running" },
		})
		this.options.setTurnPhase?.("awaiting_approval", toolAskMessage.ts)
		await this.options.postStateToWebview()
	}

	async handleAskQuestion(
		question: string,
		options: string[],
		context?: { agentId?: string; signal?: AbortSignal },
	): Promise<string> {
		if (context?.signal?.aborted) return ""
		const askData: ClineAskQuestion = { question, options: options?.length ? options : undefined }
		const ts = this.nextMessageTs()
		const id = String(ts)
		const askMessage: ClineMessage = {
			ts,
			decisionId: id,
			type: "ask",
			ask: "followup",
			text: JSON.stringify(askData),
			partial: false,
		}
		const response = new Promise<string>((resolve) => {
			const onAbort = () => this.clearPending("Agent run aborted", context?.agentId, settle)
			const settle = (answer: string) => {
				context?.signal?.removeEventListener("abort", onAbort)
				resolve(answer)
			}
			this.pendingQuestions.set(id, { id, agentId: context?.agentId, message: askMessage, resolve: settle })
			context?.signal?.addEventListener("abort", onAbort, { once: true })
		})
		this.options.onDecisionMessage?.(context?.agentId, askMessage)
		this.options.messages.appendAndEmit([askMessage], {
			type: "status",
			payload: { sessionId: this.options.getSessionId(), status: "running" },
		})
		this.updateTurnPhase()
		await this.options.postStateToWebview()
		return response
	}

	resolvePendingToolApproval(
		prompt: string | undefined,
		responseType: ClineAskResponse | undefined,
		images?: string[],
		files?: string[],
		decisionId?: string,
	): boolean {
		const decision = this.pendingApproval
		if (!decision || (decisionId && decision.id !== decisionId)) return false
		const { resolve, request } = decision
		const pendingMessage = { toolCallId: request.toolCallId, messageTs: decision.message.ts, toolName: request.toolName }

		if (responseType === "messageResponse") {
			Logger.log("[SdkController] Leaving pending tool approval open and routing user message as queued follow-up")
			this.options.setTurnPhase?.("awaiting_approval", pendingMessage?.messageTs)
			// The approval remains pending. The chat message still needs normal follow-up routing.
			return false
		}

		if (responseType !== "yesButtonClicked" && responseType !== "noButtonClicked") return false
		this.pendingApproval = undefined

		const approved = responseType === "yesButtonClicked"
		Logger.log(`[SdkController] Resolving pending tool approval: approved=${approved} (responseType=${responseType})`)
		if (approved && pendingMessage) {
			this.options.recordApprovedToolMessage?.(pendingMessage.toolCallId, pendingMessage.messageTs)
		}

		// Approved or rejected by approval controls, the agent resumes its turn and returns to streaming.
		// On rejection the agent receives the denial and continues; the SDK drives the next phase.
		this.updateTurnPhase()
		// The reason must state the operation did NOT happen (for edits: the file is
		// unchanged) — raw feedback alone reads like iteration on an applied change.
		const denialReason = buildToolApprovalDenialReason(pendingMessage?.toolName, prompt)
		if (!approved && (prompt?.trim() || images?.length || files?.length)) {
			const userMessage: ClineMessage = {
				ts: this.nextMessageTs(),
				type: "say",
				say: "user_feedback",
				text: prompt ?? "",
				images,
				files,
				partial: false,
			}
			this.options.onDecisionMessage?.(request.agentId, userMessage)
			this.options.messages.appendAndEmit([userMessage], {
				type: "status",
				payload: { sessionId: this.options.getSessionId(), status: "running" },
			})
		}
		if (!approved && pendingMessage) {
			this.options.recordDeniedToolApproval?.(pendingMessage.toolCallId, pendingMessage.toolName, denialReason)
		}
		resolve({
			approved,
			...(approved ? {} : { reason: denialReason }),
		})
		if (this.toolApprovalQueue.length > 0) void this.showNextToolApproval()
		return true
	}

	resolvePendingAskQuestion(prompt: string | undefined, decisionId?: string): boolean {
		const selectedId = decisionId || this.getPendingDecision()?.id
		const pending = selectedId ? this.pendingQuestions.get(selectedId) : undefined
		if (!pending) return false
		this.pendingQuestions.delete(pending.id)
		const responseText = prompt ?? ""
		if (responseText) {
			const userMessage: ClineMessage = {
				ts: this.nextMessageTs(),
				type: "say",
				say: "user_feedback",
				text: responseText,
				partial: false,
			}
			this.options.onDecisionMessage?.(pending.agentId, userMessage)
			this.options.messages.appendAndEmit([userMessage], {
				type: "status",
				payload: { sessionId: this.options.getSessionId(), status: "running" },
			})
		}
		this.updateTurnPhase()
		pending.resolve(responseText)
		return true
	}

	clearPending(reason: string, agentId?: string, resolver?: ApprovalResolver | ((answer: string) => void)): void {
		const matches = (pending: { request: ToolApprovalRequest; resolve: ApprovalResolver }) =>
			resolver ? pending.resolve === resolver : agentId === undefined || pending.request.agentId === agentId
		const approvals = this.toolApprovalQueue.filter(matches)
		this.toolApprovalQueue = this.toolApprovalQueue.filter((pending) => !matches(pending))
		if (this.preparingApproval && matches(this.preparingApproval)) {
			approvals.push(this.preparingApproval)
			this.preparingApproval = undefined
		}
		if (this.pendingApproval && matches(this.pendingApproval)) {
			approvals.push(this.pendingApproval)
			this.options.messages.removeMessage(this.pendingApproval.message.ts)
			this.pendingApproval = undefined
		}
		for (const pending of approvals) {
			this.options.recordDeniedToolApproval?.(pending.request.toolCallId, pending.request.toolName, reason)
			pending.resolve({ approved: false, reason })
		}
		let clearedQuestion = false
		for (const [id, pending] of this.pendingQuestions) {
			if (resolver ? pending.resolve !== resolver : agentId !== undefined && pending.agentId !== agentId) continue
			clearedQuestion = true
			this.pendingQuestions.delete(id)
			this.options.messages.removeMessage(pending.message.ts)
			pending.resolve("")
		}
		if (approvals.length || clearedQuestion) this.updateTurnPhase()
		if (!this.pendingApproval && !this.preparingApproval) void this.showNextToolApproval()
		void this.options.postStateToWebview()
	}

	/**
	 * Mint a unique message id from the SHARED minter so interaction messages (tool-approval
	 * asks, ask_question, user_feedback) never collide with translator-minted ids. Falls back to
	 * a private minter when none is wired (tests).
	 */
	private nextMessageTs(): number {
		return this.getMinter().nextId()
	}

	private fallbackMinter: MessageIdMinter | undefined
	private getMinter(): MessageIdMinter {
		if (this.options.getMinter) {
			return this.options.getMinter()
		}
		if (!this.fallbackMinter) {
			// Lazy import-free fallback: construct on first use.
			this.fallbackMinter = new MessageIdMinter()
		}
		return this.fallbackMinter
	}
}
