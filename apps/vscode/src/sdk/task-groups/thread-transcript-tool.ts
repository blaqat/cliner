import { type AgentTool, type AgentToolContext, createTool } from "@cline/shared"
import {
	formatTranscriptEntries,
	grepTranscript,
	pageTranscriptText,
	sliceTranscript,
	TRANSCRIPT_GREP_MAX_HITS,
	TRANSCRIPT_READ_MAX_CHARS,
	type TranscriptEntry,
} from "./thread-transcript"
import { REGEX_GREP_TIMEOUT_MS, runRegexGrep } from "./transcript-regex-grep"

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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

	const grepTool = createTool<{ pattern: string; thread_id?: string; regex?: boolean }, string | { error: string }>({
		name: "grep_threads",
		metadata: { subagentAccess: "read" },
		description:
			"Case-insensitive search across the user/assistant messages of mentioned threads, line by line. " +
			"By default `pattern` is a plain substring (no special characters). " +
			`Set regex=true to treat it as a JavaScript regex (e.g. \`callback|redirect_uri\`); regex searches run under a ${REGEX_GREP_TIMEOUT_MS / 1000}s time limit and are stopped if they take longer. ` +
			"Each hit reports the thread title and the message number `#<index>` usable as read_thread's start/end. " +
			"Omit thread_id to search every mentioned thread. " +
			accessNote,
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Text to find (a literal substring unless regex is true)" },
				regex: {
					type: "boolean",
					description: "Treat pattern as a JavaScript regex instead of a literal substring (default false)",
				},
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
				const useRegex = input.regex === true
				if (useRegex) {
					try {
						new RegExp(input.pattern, "i")
					} catch {
						return { error: `Invalid regex pattern: ${input.pattern}` }
					}
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
				if (useRegex) {
					const transcripts = await Promise.all(scope.map((thread) => context.readTranscript(thread.id)))
					const result = await runRegexGrep(
						input.pattern,
						transcripts.map((entries) => ({ entries })),
					)
					if (!result.ok) {
						return {
							error:
								result.reason === "timeout"
									? `${result.message} Simplify the pattern, or search for a literal substring (regex=false).`
									: `Regex search failed: ${result.message}`,
						}
					}
					hitCount = result.hits.length
					lines.push(...result.hits.map((hit) => `${scope[hit.group].title} #${hit.index}  ${hit.line}`))
				} else {
					// A literal is escaped into a regex, so it cannot backtrack.
					const pattern = new RegExp(escapeRegExp(input.pattern), "i")
					for (const thread of scope) {
						const hits = grepTranscript(
							await context.readTranscript(thread.id),
							pattern,
							TRANSCRIPT_GREP_MAX_HITS - hitCount,
						)
						hitCount += hits.length
						lines.push(...hits.map((hit) => `${thread.title} #${hit.index}  ${hit.line}`))
						if (hitCount >= TRANSCRIPT_GREP_MAX_HITS) break
					}
				}
				const truncated = hitCount >= TRANSCRIPT_GREP_MAX_HITS
				const label = useRegex ? `/${input.pattern}/` : `"${input.pattern}"`
				if (hitCount === 0) {
					return `No hits for ${label} in ${scope.length} thread(s).`
				}
				const header = `${hitCount}${truncated ? "+" : ""} hit(s) in ${scope.length} thread(s) for ${label}`
				return `${header}\n${lines.join("\n")}`
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})

	const readTool = createTool<
		{ thread_id: string; start?: number; end?: number; offset?: number; limit?: number },
		string | { error: string }
	>({
		name: "read_thread",
		metadata: { subagentAccess: "read" },
		description:
			"Reads a range of messages from a mentioned thread's transcript. " +
			"start/end are inclusive ordinals matching grep_threads' `#<index>` numbers; " +
			"defaults cover the transcript's beginning (end defaults to the last message). " +
			`Output is paged by characters: at most ${TRANSCRIPT_READ_MAX_CHARS} per call (limit lowers it). ` +
			"When a page is cut off - including inside one very long message - the result ends with a hint naming the offset to pass " +
			"(with the same start/end) to read the next page. " +
			accessNote,
		inputSchema: {
			type: "object",
			properties: {
				thread_id: { type: "string", description: "Mentioned thread id" },
				start: { type: "number", description: "First message ordinal to include (default 0)" },
				end: { type: "number", description: "Last message ordinal to include (default: last message)" },
				offset: {
					type: "number",
					description:
						"Character offset into the selected range's text to start from (default 0); use the offset from a previous page's hint",
				},
				limit: {
					type: "number",
					description: `Maximum characters to return (default and maximum ${TRANSCRIPT_READ_MAX_CHARS})`,
				},
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
				const offset = Math.trunc(input.offset ?? 0)
				if (!Number.isFinite(offset) || offset < 0)
					return { error: "offset must be a non-negative number of characters." }
				const text = formatTranscriptEntries(slice)
				if (offset > 0 && offset >= text.length) {
					return { error: `offset ${offset} is past the end of the selected range (${text.length} characters).` }
				}
				const page = pageTranscriptText(text, offset, input.limit ?? TRANSCRIPT_READ_MAX_CHARS)
				const last = slice[slice.length - 1].index
				const header = `${thread!.title} — messages ${slice[0].index}–${last} of ${entries.length - 1}, characters ${page.offset}–${page.offset + page.text.length} of ${page.total}`
				const rangeArgs = `thread_id=${thread!.id}, start=${start}, end=${end}`
				let hint = ""
				if (page.nextOffset !== undefined) {
					hint = `\n… more text in this range; call read_thread with ${rangeArgs}, offset=${page.nextOffset} to continue.`
				} else if (truncated) {
					hint = `\n… more messages follow; call read_thread with thread_id=${thread!.id}, start=${last + 1}, end=${end} to continue.`
				}
				return `${header}\n${page.text}${hint}`
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})

	return [grepTool, readTool] as AgentTool[]
}
