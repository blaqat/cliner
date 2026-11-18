import { type AgentRuntimeHooks, type AgentTool, type AgentToolContext, createTool, formatDisplayUserInput } from "@cline/shared"
import type { HistoryItem } from "@shared/HistoryItem"
import { isSyntheticSdkUserMessage } from "./sdk-user-message-mapping"
import type { SdkInitialMessages } from "./session-host"

export interface SideThreadContext {
	sessionId: string
	mainThreadId?: string
	readMessages: (id: string) => Promise<SdkInitialMessages>
	sendNote: (mainId: string, sideId: string, text: string) => Promise<void>
	consumeNotes: () => Promise<string | undefined>
}

/** Only run-start consumes notes. Tool boundaries in an active main turn leave them queued. */
export function withSideThreadNotes(hooks: AgentRuntimeHooks | undefined, context: SideThreadContext): AgentRuntimeHooks {
	return {
		...hooks,
		beforeRun: async (run) => {
			const result = await hooks?.beforeRun?.(run)
			if (result?.stop || run.snapshot.parentAgentId) return result
			const notes = await context.consumeNotes()
			return { ...result, appendContext: [result?.appendContext, notes].filter(Boolean).join("\n\n") || undefined }
		},
	}
}

/** A nested aside still talks to the original main thread. Broken ancestry grants no access. */
export async function resolveMainThread(
	item: Pick<HistoryItem, "id" | "parentTaskId" | "isSubagent" | "runtimeOwnerTaskId">,
	find: (id: string) => Promise<HistoryItem | undefined>,
): Promise<string | undefined> {
	if (!item.parentTaskId || item.isSubagent || item.runtimeOwnerTaskId) return undefined
	const seen = new Set([item.id])
	let parentId: string | undefined = item.parentTaskId
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId)
		const parent = await find(parentId)
		if (!parent || parent.isSubagent || parent.runtimeOwnerTaskId) return undefined
		if (!parent.parentTaskId) return parent.id
		parentId = parent.parentTaskId
	}
	return undefined
}

/** Summaries omit reasoning, attachments, hook context and tool output bodies. */
export function formatMainThread(messages: SdkInitialMessages, maxMessages = 30, maxChars = 12_000): string {
	const entries: string[] = []
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue
		if (message.role === "user" && isSyntheticSdkUserMessage(message)) continue
		const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
		const text = parts
			.flatMap((part) => {
				if (part.type === "text") return [message.role === "user" ? formatDisplayUserInput(part.text) : part.text]
				if (part.type === "tool_use") return [`[tool: ${part.name}]`]
				if (part.type === "tool_result") return [`[tool result: ${part.name}${part.is_error ? ": error" : ""}]`]
				return []
			})
			.join("\n")
			.trim()
		if (text) entries.push(`${message.role}: ${text}`)
	}
	const recent = entries.slice(-maxMessages).join("\n\n")
	return recent.length > maxChars
		? `[Earlier text omitted]\n${recent.slice(-(maxChars - 23))}`
		: recent || "No conversation yet."
}

export function createSideThreadTools(context?: SideThreadContext): AgentTool[] {
	if (!context?.mainThreadId) return []
	const mainId = context.mainThreadId
	// No subagentAccess metadata: the SDK does not inherit these tools into helpers.
	const allowed = (call: AgentToolContext) => call.sessionId === context.sessionId
	return [
		createTool<{ max_messages?: number; max_chars?: number }, string | { error: string }>({
			name: "read_main_thread",
			description:
				"Read the original main thread's latest user and assistant messages and tool summaries, newest last. Use this inside a side thread to catch up on changes since it started. Reasoning, attachments and full tool outputs are omitted. This does not run the main thread.",
			inputSchema: {
				type: "object",
				properties: {
					max_messages: {
						type: "integer",
						minimum: 1,
						maximum: 100,
						description: "Recent messages to include, default 30, maximum 100.",
					},
					max_chars: {
						type: "integer",
						minimum: 100,
						maximum: 40000,
						description: "Maximum output characters, default 12000, maximum 40000. Older text is omitted first.",
					},
				},
			},
			retryable: false,
			execute: async (input, call) => {
				if (!allowed(call)) return { error: "Only the side thread can read its main thread." }
				const count = input.max_messages ?? 30
				const chars = input.max_chars ?? 12_000
				if (
					!Number.isInteger(count) ||
					count < 1 ||
					count > 100 ||
					!Number.isInteger(chars) ||
					chars < 100 ||
					chars > 40_000
				)
					return { error: "max_messages must be 1..100 and max_chars 100..40000." }
				try {
					return formatMainThread(await context.readMessages(mainId), count, chars)
				} catch (error) {
					return { error: `Cannot read main thread: ${String(error)}` }
				}
			},
		}) as AgentTool,
		createTool<{ message: string }, { queued?: boolean; error?: string }>({
			name: "send_to_main_thread",
			description:
				"Send a short note or useful context from this side thread to the original main thread. The note appears in its transcript immediately and is held for its next turn, even if it is currently running. Never starts, interrupts or resumes a main-thread model call. Do not use this to request immediate work or assume a reply.",
			inputSchema: {
				type: "object",
				properties: {
					message: {
						type: "string",
						minLength: 1,
						maxLength: 4000,
						description: "Concise context to share, at most 4000 characters.",
					},
				},
				required: ["message"],
			},
			retryable: false,
			execute: async (input, call) => {
				if (!allowed(call)) return { error: "Only the side thread can send to its main thread." }
				if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 4000)
					return { error: "message must contain 1..4000 characters." }
				try {
					await context.sendNote(mainId, context.sessionId, input.message.trim())
					return { queued: true }
				} catch (error) {
					return { error: `Cannot send to main thread: ${String(error)}` }
				}
			},
		}) as AgentTool,
	]
}
