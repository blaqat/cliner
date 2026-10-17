export interface ThreadMentionResolution {
	/** The thread's session id — what the transcript tools key on. */
	id: string
	title: string
}

export type ThreadMentionResolver = (id: string) => Promise<ThreadMentionResolution | undefined>

// `thread:<id>` at a word start — not inside `a.b/thread:x`, `x@thread:` or a
// `vscode://.../thread/` link. Ids are session ids (`<digits>_<nanoid>`), but
// the pattern is lenient: unmatched ids simply stay literal text.
const THREAD_MENTION_PATTERN = /(?<![\w/@#.])thread:([0-9A-Za-z_-]+)/g

/** Raw ids of every `thread:<id>` mention in `text`, in order of appearance. */
export function extractThreadMentionIds(text: string): string[] {
	return [...new Set([...text.matchAll(THREAD_MENTION_PATTERN)].map((match) => match[1]))]
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Replaces `thread:<id>` mentions with a `<thread_reference>` tag carrying the
 * thread's id and title — never the transcript itself. Returns the replaced
 * text plus the ids that resolved, which the caller records as the
 * conversation's transcript allow-list (the grep_threads/read_thread tools
 * refuse any id not in it).
 *
 * `typedIds` (from {@link extractThreadMentionIds} on the user's original
 * composer input) limits which mentions may expand and authorize. Text pulled
 * in by note/file/slash-command expansion can contain `thread:<id>` too, but
 * only the user's own typing or picking grants transcript access, so those
 * mentions stay literal.
 */
export async function expandThreadMentions(
	text: string,
	resolve: ThreadMentionResolver,
	typedIds?: ReadonlySet<string>,
): Promise<{ text: string; threadIds: string[] }> {
	const resolutions = new Map<string, string>()
	const threadIds: string[] = []
	for (const match of text.matchAll(THREAD_MENTION_PATTERN)) {
		const key = match[0]
		if (resolutions.has(key)) continue
		if (typedIds && !typedIds.has(match[1])) continue
		const thread = await resolve(match[1])
		if (!thread) continue
		threadIds.push(thread.id)
		resolutions.set(
			key,
			`<thread_reference id="${escapeAttr(thread.id)}" title="${escapeAttr(thread.title)}">The user referenced this thread. Its transcript is not included here — grep and read it with the thread_transcript tools (grep_threads / read_thread), which only accept thread ids the user has mentioned.</thread_reference>`,
		)
	}
	return {
		text: text.replace(THREAD_MENTION_PATTERN, (match) => resolutions.get(match) ?? match),
		threadIds,
	}
}
