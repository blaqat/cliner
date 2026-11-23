import {
	type AutomationArgument,
	type AutomationDefinition,
	type AutomationOutput,
	type AutomationStep,
	type AutomationThreadSpec,
	slugifyStepId,
	uniqueStepId,
} from "@shared/automations"

/** One thread of the task, as the user started it. */
export interface TaskThreadForAutomation {
	title: string
	/** The first message the user sent. */
	prompt: string
	/** When it started; threads started within a minute of each other with the same prompt ran together. */
	startedTs: number
	/** A configured model's name, or empty for the default. */
	model: string
	level: string
	worktree: boolean
	/** When the mode the thread started in isn't known, worktree threads count as Act, others as Ask. */
	mode?: "ask" | "act"
	outputs?: AutomationOutput[]
}

const TOGETHER_WINDOW_MS = 60_000

/** A short step id from a title: its first three words. */
function shortId(text: string): string {
	return slugifyStepId(text.split(/\s+/).slice(0, 3).join(" ")).slice(0, 24).replace(/-+$/, "") || "thread"
}

/**
 * A draft automation from a task's threads, for "Save this task as an automation": each thread becomes a
 * step in the order it started, threads started together with the same prompt become one Threads
 * together step, and the task's ticket becomes a `{{ticket}}` argument wherever it appears. No model call:
 * the user checks the draft in the builder before saving.
 */
export function automationFromTask(task: { title: string; ticket?: string; threads: readonly TaskThreadForAutomation[] }): {
	definition: AutomationDefinition
	guesses: string[]
} {
	const guesses: string[] = []
	const ticket = task.ticket?.trim()
	const generalize = (text: string) => (ticket ? text.split(ticket).join("{{ticket}}") : text)
	const sorted = [...task.threads].filter((thread) => thread.prompt.trim()).sort((a, b) => a.startedTs - b.startedTs)
	// The same prompt on the same model again (a task run twice) is one step, not two.
	const seen = new Set<string>()
	const threads = sorted.filter((thread) => {
		const key = `${generalize(thread.prompt.trim())}\u0000${thread.model}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
	const steps: AutomationStep[] = []
	let guessedModes = false
	const spec = (thread: TaskThreadForAutomation, id: string): AutomationThreadSpec => {
		if (!thread.mode) guessedModes = true
		return {
			id,
			title: generalize(thread.title.trim() || "Thread"),
			prompt: generalize(thread.prompt.trim()),
			model: thread.model,
			level: thread.level,
			mode: thread.mode ?? (thread.worktree ? "act" : "ask"),
			worktree: thread.worktree,
			...(thread.outputs?.length ? { outputs: thread.outputs } : {}),
		}
	}
	for (let index = 0; index < threads.length; index++) {
		const first = threads[index]
		const group = [first]
		while (
			index + 1 < threads.length &&
			threads[index + 1].prompt.trim() === first.prompt.trim() &&
			threads[index + 1].startedTs - first.startedTs <= TOGETHER_WINDOW_MS
		)
			group.push(threads[++index])
		if (group.length === 1) {
			const id = uniqueStepId(shortId(generalize(first.title || first.prompt).replace(/\{\{ticket\}\}/g, "ticket")), steps)
			steps.push({ kind: "thread", ...spec(first, id), id })
			continue
		}
		const id = uniqueStepId("together", steps)
		const members = group.map((thread, member) => ({ ...spec(thread, `${id}-${member + 1}`), prompt: "" }))
		steps.push({ kind: "together", id, title: "Together", prompt: generalize(first.prompt.trim()), threads: members })
	}
	const args: AutomationArgument[] = ticket
		? [{ name: "ticket", kind: "ticket", required: true, description: "The ticket this run is for" }]
		: []
	if (ticket) guesses.push(`“${ticket}” became {{ticket}} in prompts and titles, so each run can take a different ticket.`)
	if (guessedModes) guesses.push("Modes are a guess: threads in a worktree are Act, the rest Ask.")
	if (threads.length > 1)
		guesses.push(
			"Steps run in the order the threads started. Insert an earlier reply or named output in a later prompt where you need it.",
		)
	if (threads.length < task.threads.length)
		guesses.push("Threads with no first message, or repeating an earlier one, were left out.")
	const name =
		slugifyStepId(generalize(task.title).replace(/\{\{ticket\}\}/g, ""))
			.slice(0, 40)
			.replace(/^step-/, "")
			.replace(/-+$/, "") || "my-automation"
	return {
		definition: {
			name,
			title: generalize(task.title)
				.replace(/\s*\{\{ticket\}\}\s*/g, " ")
				.replace(/[\s·:\-–—|]+$/, "")
				.trim(),
			description: `Repeats the task “${task.title}”`,
			arguments: args,
			steps,
		},
		guesses,
	}
}
