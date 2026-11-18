import type { AutomationDefinition } from "@shared/automations"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** "4 steps · 4 threads · 3 models · pauses once", for list rows. */
export function stepSummary(definition: AutomationDefinition): string {
	const threads = definition.steps.flatMap((step) =>
		step.kind === "thread" ? [step] : step.kind === "together" ? step.threads : [],
	)
	const models = new Set(threads.map((thread) => thread.model || "default"))
	const pauses = definition.steps.filter((step) => step.kind === "checkpoint").length
	return [
		plural(definition.steps.length, "step"),
		threads.length ? plural(threads.length, "thread") : "",
		models.size > 1 ? plural(models.size, "model") : "",
		pauses ? (pauses === 1 ? "pauses once" : `pauses ${pauses} times`) : "",
	]
		.filter(Boolean)
		.join(" · ")
}
