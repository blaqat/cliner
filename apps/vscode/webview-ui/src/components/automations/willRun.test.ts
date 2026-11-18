import type { AutomationDefinition, AutomationRun } from "@shared/automations"
import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { stepSummary } from "./automationSummary"
import { describeRun, summarizeRun } from "./willRun"

const definition: AutomationDefinition = {
	name: "ship",
	title: "",
	description: "d",
	arguments: [{ name: "ticket", kind: "ticket", required: true, description: "" }],
	steps: [
		{ kind: "task", id: "task", title: "Open {{ticket}}", ticket: "{{ticket}}", newTaskTitle: "" },
		{ kind: "thread", id: "plan", title: "Plan", prompt: "p", model: "Opus", level: "", mode: "ask", worktree: false },
		{ kind: "checkpoint", id: "ok", title: "Check", question: "Go?", choicesFrom: "", choices: [] },
		{
			kind: "thread",
			id: "build",
			title: "Build",
			prompt: "b {{steps.plan}}",
			model: "",
			level: "",
			mode: "act",
			worktree: true,
		},
	],
}

describe("describeRun", () => {
	it("lists every step with its model, mode and worktree", () => {
		const willRun = describeRun(definition, { ticket: "P-1" }, undefined, { inTask: false })
		expect(willRun.steps.map((step) => [step.number, step.title, step.detail])).toEqual([
			[1, "Open P-1", "Finds the task tagged P-1, or makes one"],
			[2, "Plan", undefined],
			[3, "Check", "Waits for you to continue"],
			[4, "Build", undefined],
		])
		expect(willRun.steps[3].threads[0]).toMatchObject({ mode: "Act", worktree: true, model: "Your current model" })
		expect(summarizeRun(willRun)).toBe("2 threads on 2 models · 1 worktree · pauses once")
		expect(willRun.cost).toContain("Cost depends on")
	})

	it("adds a new task when the run isn't in one and has no task step", () => {
		const noTask = { ...definition, steps: definition.steps.slice(1) }
		expect(describeRun(noTask, {}, undefined, { inTask: false }).steps[0].title).toBe("New task")
		expect(describeRun(noTask, {}, undefined, { inTask: true }).steps[0].title).toBe("Plan")
	})

	it("uses what earlier runs cost when there are some", () => {
		const run = (id: string, threads: string[]): AutomationRun => ({
			id,
			automation: "ship",
			title: "Ship",
			values: {},
			taskGroupId: "g",
			status: "done",
			startedAt: 1,
			steps: [
				{
					id: "plan",
					kind: "thread",
					title: "Plan",
					status: "done",
					threads: threads.map((threadId) => ({
						id: "plan",
						threadId,
						title: "Plan",
						model: "",
						level: "",
						mode: "ask" as const,
						worktree: false,
						status: "done" as const,
					})),
				},
			],
		})
		const history = [
			{ id: "a", totalCost: 0.4 },
			{ id: "b", totalCost: 0.5 },
			{ id: "c", totalCost: 1.2 },
		] as HistoryItem[]
		const willRun = describeRun(definition, {}, undefined, {
			inTask: true,
			earlierRuns: [run("1", ["a", "b"]), run("2", ["c"])],
			history,
		})
		expect(willRun.cost).toBe("Last 2 runs $0.90–$1.20")
	})
})

describe("stepSummary", () => {
	it("counts steps, threads, models and pauses", () => {
		expect(stepSummary(definition)).toBe("4 steps · 2 threads · 2 models · pauses once")
	})
})
