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

	it("shows the workspace of the parent and each item's steps separately", () => {
		const fanOut: AutomationDefinition = {
			...definition,
			steps: [
				definition.steps[1],
				{ kind: "each", id: "each", title: "For each", items: "{{context}}", ticket: "", newTaskTitle: "", atOnce: 2 },
				definition.steps[3],
			],
		}
		const run = describeRun(fanOut, {}, undefined, { inTask: true, text: "A-1, A-2" })
		expect(run.steps[0].threads[0].worktreeScope).toBeUndefined()
		expect(run.steps[1].detail).toBe("Step 3 runs for each of 2 items. Up to 2 items at a time, each in its own task.")
		expect(run.steps[2]).toMatchObject({ perItem: true, threads: [{ worktreeScope: "task" }] })
		expect(summarizeRun(run)).toBe("1 thread · 1 thread, 1 worktree per item")
	})

	it.each([
		[0.4, 0.5, 1.2, "Last 2 runs $0.90–$1.20"],
		[0.0004, 0.0006, 12.5, "Last 2 runs $0.001–$12.50"],
	])("formats earlier run costs of %s, %s and %s", (first, second, third, label) => {
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
			{ id: "a", totalCost: first },
			{ id: "b", totalCost: second },
			{ id: "c", totalCost: third },
		] as HistoryItem[]
		const willRun = describeRun(definition, {}, undefined, {
			inTask: true,
			earlierRuns: [run("1", ["a", "b"]), run("2", ["c"])],
			history,
		})
		expect(willRun.cost).toBe(label)
	})
})

describe("stepSummary", () => {
	it("counts steps, threads, models and pauses", () => {
		expect(stepSummary(definition)).toBe("4 steps · 2 threads · 2 models · pauses once")
	})
})
