import { type AgentTool, type AgentToolContext, createTool } from "@cline/shared"
import { grepTranscript, sliceTranscript, TRANSCRIPT_GREP_MAX_HITS, type TranscriptEntry } from "./thread-transcript"

export interface ThreadTranscriptSummary {
	id: string
	title: string
}

export interface ThreadTranscriptToolsContext {
	/**
	 * The conversation thread whose allow-list applies to this call. For a
	 * subagent executing the tool this resolves to the owning user-facing
	 * thread — `context.sessionId` is the child session's id.
	 */
	resolveOwnerThreadId: (context: AgentToolContext) => Promise<string>
	/** True when `threadId` was user-mentioned (via `thread:<id>`) in the owner thread. */
	isThreadAllowed: (ownerThreadId: string, threadId: string) => Promise<boolean>
	/** Every thread currently on the owner thread's allow-list, for errors and unscoped greps. */
	listAllowedThreads: (ownerThreadId: string) => Promise<ThreadTranscriptSummary[]>
	/** Loads a thread's transcript as numbered user/assistant entries. */
	readTranscript: (threadId: string) => Promise<TranscriptEntry[]>
}

function allowedListText(threads: ThreadTranscriptSummary[]): string {
	return threads.length === 0 ? "none" : threads.map((thread) => `"${thread.title}" (${thread.id})`).join(", ")
}

const accessNote =
	"Only works for threads the user mentioned in this conversation with thread:<id>; any other thread id is refused. The agent cannot list or search threads the user has not mentioned."

export async function createThreadTranscriptTools(context: ThreadTranscriptToolsContext): Promise<AgentTool[]> {
	const allowedThreads = async (toolContext: AgentToolContext) => {
		const ownerThreadId = await context.resolveOwnerThreadId(toolContext)
		const threads = await context.listAllowedThreads(ownerThreadId)
		return { ownerThreadId, threads }
	}

	const requireAllowedThread = async (
		threadId: string,
		toolContext: AgentToolContext,
	): Promise<{ thread?: ThreadTranscriptSummary; error?: { error: string } }> => {
		const { ownerThreadId, threads } = await allowedThreads(toolContext)
		const thread = threads.find((entry) => entry.id === threadId)
		if (!thread || !(await context.isThreadAllowed(ownerThreadId, threadId))) {
			return {
				error: {
					error: `Thread "${threadId}" was not mentioned in this conversation — thread transcripts are only readable for thread:<id> references the user sent. Allowed: ${allowedListText(threads)}.`,
				},
			}
		}
		return { thread }
	}

	const grepTool = createTool<{ pattern: string; thread_id?: string }, string | { error: string }>({
		name: "grep_threads",
		metadata: { subagentAccess: "read" },
		description:
			"Case-insensitive regex grep across the user/assistant messages of mentioned threads. " +
			"Each hit reports the thread title and the message number `#<index>` usable as read_thread's start/end. " +
			"Omit thread_id to search every mentioned thread. " +
			accessNote,
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "JavaScript regex, case-insensitive (e.g. `callback|redirect_uri`)" },
				thread_id: { type: "string", description: "Mentioned thread id; omit to grep all mentioned threads" },
			},
			required: ["pattern"],
		},
		retryable: false,
		execute: async (input, toolContext) => {
			try {
				if (!input.pattern?.trim()) {
					return { error: "pattern is required." }
				}
				let pattern: RegExp
				try {
					pattern = new RegExp(input.pattern, "i")
				} catch {
					return { error: `Invalid regex pattern: ${input.pattern}` }
				}
				const { threads } = await allowedThreads(toolContext)
				const scope = input.thread_id ? threads.filter((thread) => thread.id === input.thread_id) : threads
				if (input.thread_id && scope.length === 0) {
					return {
						error: `Thread "${input.thread_id}" was not mentioned in this conversation — thread transcripts are only readable for thread:<id> references the user sent. Allowed: ${allowedListText(threads)}.`,
					}
				}
				if (scope.length === 0) {
					return { error: "No threads were mentioned in this conversation — there is nothing to grep." }
				}
				const lines: string[] = []
				let hitCount = 0
				let truncated = false
				for (const thread of scope) {
					const entries = await context.readTranscript(thread.id)
					const hits = grepTranscript(entries, pattern, TRANSCRIPT_GREP_MAX_HITS - hitCount)
					hitCount += hits.length
					if (hits.length > 0) {
						lines.push(...hits.map((hit) => `${thread.title} #${hit.index}  ${hit.line}`))
					}
					if (hitCount >= TRANSCRIPT_GREP_MAX_HITS) {
						truncated = true
						break
					}
				}
				if (hitCount === 0) {
					return `No hits for /${input.pattern}/ in ${scope.length} thread(s).`
				}
				const header = `${hitCount}${truncated ? "+" : ""} hit(s) in ${scope.length} thread(s) for /${input.pattern}/`
				return `${header}\n${lines.join("\n")}`
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})

	const readTool = createTool<{ thread_id: string; start?: number; end?: number }, string | { error: string }>({
		name: "read_thread",
		metadata: { subagentAccess: "read" },
		description:
			"Reads a range of messages from a mentioned thread's transcript. " +
			"start/end are inclusive ordinals matching grep_threads' `#<index>` numbers; " +
			"defaults cover the transcript's beginning (end defaults to the last message). " +
			accessNote,
		inputSchema: {
			type: "object",
			properties: {
				thread_id: { type: "string", description: "Mentioned thread id" },
				start: { type: "number", description: "First message ordinal to include (default 0)" },
				end: { type: "number", description: "Last message ordinal to include (default: last message)" },
			},
			required: ["thread_id"],
		},
		retryable: false,
		execute: async (input, toolContext) => {
			try {
				const { thread, error } = await requireAllowedThread(input.thread_id, toolContext)
				if (error) return error
				const entries = await context.readTranscript(thread!.id)
				if (entries.length === 0) {
					return `Thread "${thread!.title}" has no user/assistant messages.`
				}
				const start = Math.max(0, Math.trunc(input.start ?? 0))
				const end = Math.trunc(input.end ?? entries[entries.length - 1].index)
				if (start > end) {
					return { error: `start (${start}) is after end (${end}).` }
				}
				const { entries: slice, truncated } = sliceTranscript(entries, start, end)
				if (slice.length === 0) {
					return {
						error: `No messages in range ${start}–${end}; the transcript has ${entries.length} messages (0–${entries.length - 1}).`,
					}
				}
				const lines = slice.map((entry) => `#${entry.index} ${entry.role}: ${entry.text}`)
				const suffix = truncated ? `\n… truncated; narrow the range to read more.` : ""
				return `${thread!.title} — messages ${slice[0].index}–${slice[slice.length - 1].index} of ${entries.length - 1}\n${lines.join("\n\n")}${suffix}`
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})

	return [grepTool, readTool] as AgentTool[]
}
