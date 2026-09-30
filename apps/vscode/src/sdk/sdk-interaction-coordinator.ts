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

export class SdkInteractionCoordinator {
	private pendingAskResolve: ((answer: string) => void) | undefined
	private pendingToolApprovalRequest: ToolApprovalRequest | undefined
	private pendingToolApprovalResolve: ((result: { approved: boolean; reason?: string }) => void) | undefined
	private pendingToolApprovalMessage:
		| {
				toolCallId: string
				messageTs: number
				toolName: string
		  }
		| undefined

	private toolApprovalQueue: {
		request: ToolApprovalRequest
		resolve: (result: { approved: boolean; reason?: string }) => void
	}[] = []

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
		const askMcpRequiresApproval =
			this.options.getMode?.() === "plan" && request.toolName.includes("__") && request.policy.requireApproval !== false
		if (
			!askMcpRequiresApproval &&
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
				const reason = "Agent run aborted"
				this.options.recordDeniedToolApproval?.(request.toolCallId, request.toolName, reason)
				this.toolApprovalQueue = this.toolApprovalQueue.filter((pending) => pending.resolve !== settle)
				if (this.pendingToolApprovalResolve === settle) {
					const message = this.pendingToolApprovalMessage
					this.pendingToolApprovalResolve = undefined
					this.pendingToolApprovalRequest = undefined
					this.pendingToolApprovalMessage = undefined
					if (message) this.options.messages.removeMessage(message.messageTs)
					if (this.toolApprovalQueue.length === 0) this.options.setTurnPhase?.("streaming")
					void this.showNextToolApproval()
					void this.options.postStateToWebview()
				}
				settle({ approved: false, reason })
			}
			request.signal?.addEventListener("abort", onAbort, { once: true })
			this.toolApprovalQueue.push({ request, resolve: settle })
			if (request.signal?.aborted) onAbort()
			else if (!this.pendingToolApprovalResolve) void this.showNextToolApproval()
		})
	}

	private async showNextToolApproval(): Promise<void> {
		const pending = this.toolApprovalQueue.shift()
		if (!pending) return
		const { request, resolve } = pending
		this.pendingToolApprovalResolve = resolve
		this.pendingToolApprovalRequest = request
		// Reserve the active slot before awaiting the preview. Concurrent children queue behind it.
		try {
			await this.options.onToolApprovalAsk?.(request)
		} catch (error) {
			Logger.warn(`[SdkController] onToolApprovalAsk failed; showing plain approval ask: ${error}`)
		}
		if (this.pendingToolApprovalResolve !== resolve) return
		const toolAskMessage = buildToolApprovalAskMessage(
			request.toolName,
			request.input,
			this.nextMessageTs(),
			this.options.getCwd?.(),
		)
		this.pendingToolApprovalMessage = {
			toolCallId: request.toolCallId,
			messageTs: toolAskMessage.ts,
			toolName: request.toolName,
		}
		this.options.messages.appendAndEmit([toolAskMessage], {
			type: "status",
			payload: { sessionId: this.options.getSessionId(), status: "running" },
		})
		this.options.setTurnPhase?.("awaiting_approval", toolAskMessage.ts)
		await this.options.postStateToWebview()
	}

	async handleAskQuestion(question: string, options: string[], _context: unknown): Promise<string> {
		const askData: ClineAskQuestion = {
			question,
			options: options?.length ? options : undefined,
		}
		const askMessage: ClineMessage = {
			ts: this.nextMessageTs(),
			type: "ask",
			ask: "followup",
			text: JSON.stringify(askData),
			partial: false,
		}

		const response = new Promise<string>((resolve) => {
			this.pendingAskResolve = resolve
		})
		this.options.messages.appendAndEmit([askMessage], {
			type: "status",
			payload: { sessionId: this.options.getSessionId(), status: "running" },
		})
		this.options.setTurnPhase?.("awaiting_followup", askMessage.ts)
		await this.options.postStateToWebview()

		return response
	}

	resolvePendingToolApproval(
		prompt: string | undefined,
		responseType: ClineAskResponse | undefined,
		images?: string[],
		files?: string[],
	): boolean {
		if (!this.pendingToolApprovalResolve) {
			return false
		}

		const resolve = this.pendingToolApprovalResolve
		const pendingMessage = this.pendingToolApprovalMessage

		if (responseType === "messageResponse") {
			Logger.log("[SdkController] Leaving pending tool approval open and routing user message as queued follow-up")
			this.options.setTurnPhase?.("awaiting_approval", pendingMessage?.messageTs)
			// The approval remains pending. The chat message still needs normal follow-up routing.
			return false
		}

		this.pendingToolApprovalResolve = undefined
		this.pendingToolApprovalRequest = undefined
		this.pendingToolApprovalMessage = undefined

		const approved = responseType === "yesButtonClicked"
		Logger.log(`[SdkController] Resolving pending tool approval: approved=${approved} (responseType=${responseType})`)
		if (approved && pendingMessage) {
			this.options.recordApprovedToolMessage?.(pendingMessage.toolCallId, pendingMessage.messageTs)
		}

		// Approved or rejected by approval controls, the agent resumes its turn and returns to streaming.
		// On rejection the agent receives the denial and continues; the SDK drives the next phase.
		if (this.toolApprovalQueue.length === 0) this.options.setTurnPhase?.("streaming")
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

	resolvePendingAskQuestion(prompt: string | undefined): boolean {
		if (!this.pendingAskResolve) {
			return false
		}

		const resolve = this.pendingAskResolve
		this.pendingAskResolve = undefined
		const responseText = prompt ?? ""
		Logger.log(`[SdkController] Resolving pending ask_question with: "${responseText.substring(0, 80)}"`)

		if (responseText) {
			const userMessage: ClineMessage = {
				ts: this.nextMessageTs(),
				type: "say",
				say: "user_feedback",
				text: responseText,
				partial: false,
			}
			this.options.messages.appendAndEmit([userMessage], {
				type: "status",
				payload: { sessionId: this.options.getSessionId(), status: "running" },
			})
		}

		// User answered the follow-up — the agent resumes its turn.
		this.options.setTurnPhase?.("streaming")
		resolve(responseText)
		return true
	}

	clearPending(reason: string): void {
		for (const pending of this.toolApprovalQueue.splice(0)) {
			this.options.recordDeniedToolApproval?.(pending.request.toolCallId, pending.request.toolName, reason)
			pending.resolve({ approved: false, reason })
		}
		const resolveAsk = this.pendingAskResolve
		this.pendingAskResolve = undefined
		// ask_question is awaiting this promise inside the outgoing agent run. Settle it
		// before session teardown so the run can unwind instead of remaining suspended;
		// use an empty answer so the lifecycle reason is not presented as user input.
		resolveAsk?.("")

		const pendingRequest = this.pendingToolApprovalRequest
		this.pendingToolApprovalRequest = undefined
		const pendingMessage = this.pendingToolApprovalMessage
		if (pendingMessage) this.options.messages.removeMessage(pendingMessage.messageTs)
		this.pendingToolApprovalMessage = undefined
		if (this.pendingToolApprovalResolve) {
			// Record before resolving: the denial unblocks the core, which emits the
			// tool's lifecycle events before the caller's abort lands. Unless the
			// denial is already recorded, the translator renders those events as a
			// second tool row next to the still-visible approval ask.
			if (pendingRequest) {
				this.options.recordDeniedToolApproval?.(pendingRequest.toolCallId, pendingRequest.toolName, reason)
			}
			this.pendingToolApprovalResolve({ approved: false, reason })
			this.pendingToolApprovalResolve = undefined
		}
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
