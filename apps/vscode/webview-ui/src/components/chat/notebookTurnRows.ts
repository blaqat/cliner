import type { ClineMessage } from "@shared/ExtensionMessage"

/** Rows that never render, so they don't split a turn's review rows apart. */
const INVISIBLE = new Set(["api_req_started", "api_req_finished", "checkpoint_created", "deleted_api_reqs", "subagent_usage"])

function groupOf(message: ClineMessage): string | undefined {
	try {
		return (JSON.parse(message.text ?? "{}") as { taskGroupId?: string }).taskGroupId
	} catch {
		return undefined
	}
}

const isReview = (message: ClineMessage | undefined) => message?.type === "say" && message.say === "notebook_changes"
const isInvisible = (message: ClineMessage) => message.type === "say" && !!message.say && INVISIBLE.has(message.say)

/**
 * The review rows one turn ended with: the host writes one per kind (task
 * notes, About you, skills) back to back. They show as one row, led by the
 * first. A kind seen twice starts a new run (older histories kept a row per turn).
 */
export function notebookTurnRun(messages: ClineMessage[], index: number): ClineMessage[] {
	if (!isReview(messages[index])) return []
	let start = index
	for (let i = index - 1; i >= 0; i--) {
		if (isInvisible(messages[i])) continue
		if (!isReview(messages[i])) break
		start = i
	}
	const run: ClineMessage[] = []
	const groups = new Set<string | undefined>()
	for (let i = start; i < messages.length; i++) {
		const message = messages[i]
		if (isInvisible(message)) continue
		if (!isReview(message)) break
		const group = groupOf(message)
		if (groups.has(group)) {
			if (i > index) break
			// The message before this one ended an earlier run.
			run.length = 0
			groups.clear()
		}
		groups.add(group)
		run.push(message)
	}
	return run
}

/** True for a review row another row of the same turn already shows. */
export function isNotebookRunFollower(messages: ClineMessage[], index: number): boolean {
	const run = notebookTurnRun(messages, index)
	return run.length > 1 && run[0] !== messages[index]
}
