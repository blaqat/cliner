import type { AutomationDefinition, AutomationRun, AutomationThreadStep } from "@shared/automations"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { parseAutomationFile, serializeAutomation } from "./automation-file"
import { precheckSteps } from "./automation-precheck"
import { AutomationRunner, type AutomationRunnerDeps, type StartThreadInput, type StoredAutomationRun } from "./automation-runner"

const say = (text: string): ClineMessage => ({ ts: 1, type: "say", say: "completion_result", text })
const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function fanOut(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
	return {
		name: "fix-all",
		title: "Fix all",
		description: "Fixes every ticket",
		arguments: [{ name: "tickets", kind: "text", required: true, description: "Tickets" }],
		steps: [
			{
				kind: "thread",
				id: "plan",
				title: "Plan",
				prompt: "Plan fixes for {{tickets}}.",
				model: "",
				level: "",
				mode: "ask",
				worktree: false,
			},
			{
				kind: "each",
				id: "each",
				title: "Each ticket",
				items: "{{tickets}}",
				ticket: "{{item}}",
				newTaskTitle: "",
				atOnce: 2,
			},
			{
				kind: "thread",
				id: "fix",
				title: "Fix {{item}}",
				prompt: "Fix {{item}} using {{steps.plan}}.",
				model: "",
				level: "",
				mode: "act",
				worktree: false,
			},
		],
		...overrides,
	}
}

function harness(
	options: {
		threadCost?: (id: string) => number | undefined
		failStart?: (input: StartThreadInput) => boolean
		precheck?: AutomationRunnerDeps["precheck"]
	} = {},
) {
	const started: (StartThreadInput & { threadId: string })[] = []
	const stopped: string[] = []
	const tasks: { ticket?: string; title: string }[] = []
	let latest: readonly AutomationRun[] = []
	let saved: readonly StoredAutomationRun[] = []
	let n = 0
	let ids = 0
	const runner = new AutomationRunner({
		findOrCreateTask: async (ticket, title) => {
			tasks.push({ ticket, title })
			return `group-${ticket}`
		},
		createTask: async (title, ticket) => {
			tasks.push({ title, ticket })
			return `group-new-${tasks.length}`
		},
		startThread: async (input) => {
			if (options.failStart?.(input)) throw new Error(`Couldn't start ${input.title}`)
			const threadId = `thread-${++n}`
			started.push({ ...input, threadId })
			return threadId
		},
		stopThread: async (id) => {
			stopped.push(id)
		},
		threadCost: options.threadCost,
		precheck: options.precheck,
		onChange: (runs) => {
			latest = runs
		},
		save: async (runs) => {
			saved = runs
		},
		newId: () => `run-${++ids}`,
		now: () => 1000,
	})
	const finish = async (threadId: string, reply: string) => {
		runner.threadStatusChanged(threadId, "done", () => [say(reply)])
		await flush()
	}
	const byId = (id: string) => latest.find((run) => run.id === id) as AutomationRun
	return { runner, started, stopped, tasks, finish, byId, runs: () => latest, saved: () => saved }
}

describe("context from the user", () => {
	it("goes after every thread's prompt as a marked block, with the attachments", async () => {
		const h = harness()
		const definition = fanOut({ steps: fanOut().steps.slice(0, 1) })
		await h.runner.start(
			definition,
			{ tickets: "A-1" },
			{ context: { text: "Only touch the API.", images: ["data:image/png;base64,AAA"], files: ["/repo/notes.md"] } },
		)
		await flush()
		expect(h.started[0].prompt).toBe("Plan fixes for A-1.\n\n## Context from you\n\nOnly touch the API.")
		expect(h.started[0].images).toEqual(["data:image/png;base64,AAA"])
		expect(h.started[0].files).toEqual(["/repo/notes.md"])
		const run = h.byId("run-1")
		expect(run.context).toEqual({ text: "Only touch the API.", files: ["/repo/notes.md"], images: 1 })
		expect(run.values).toEqual({ tickets: "A-1" })
		// The images stay on disk with the run, not on the wire.
		expect(h.saved().find((saved) => saved.id === "run-1")?.contextImages).toEqual(["data:image/png;base64,AAA"])
	})

	it("goes only where the automation puts {{context}}", async () => {
		const h = harness()
		const definition = fanOut({
			arguments: [],
			steps: [
				{
					kind: "thread",
					id: "a",
					title: "A",
					prompt: "Read this: {{context}}",
					model: "",
					level: "",
					mode: "ask",
					worktree: false,
				},
				{
					kind: "thread",
					id: "b",
					title: "B",
					prompt: "Summarize {{steps.a}}",
					model: "",
					level: "",
					mode: "ask",
					worktree: false,
				},
			],
		})
		await h.runner.start(definition, {}, { context: { text: "the notes", images: ["data:x"] } })
		await flush()
		expect(h.started[0].prompt).toBe("Read this: the notes")
		expect(h.started[0].images).toEqual(["data:x"])
		await h.finish("thread-1", "done a")
		expect(h.started[1].prompt).toBe("Summarize done a")
		expect(h.started[1].images).toBeUndefined()
	})

	it("leaves prompts alone when none is given", async () => {
		const h = harness()
		await h.runner.start(fanOut({ steps: fanOut().steps.slice(0, 1) }), { tickets: "A-1" })
		await flush()
		expect(h.started[0].prompt).toBe("Plan fixes for A-1.")
		expect(h.started[0].images).toBeUndefined()
		expect(h.byId("run-1").context).toBeUndefined()
	})
})

describe("For each", () => {
	it("shares a worktree within each item's task and keeps the parent in its own workspace", async () => {
		const checks: (string | undefined)[] = []
		const h = harness({
			precheck: async (_steps, taskGroupId) => {
				checks.push(taskGroupId)
				return []
			},
		})
		const definition = fanOut()
		const fix = { ...(definition.steps[2] as AutomationThreadStep), worktreeScope: "task" as const }
		definition.steps = [
			...definition.steps.slice(0, 2),
			fix,
			{ ...fix, id: "review", title: "Review {{item}}", mode: "ask", worktreeScope: undefined },
			{ ...fix, id: "compare", title: "Compare {{item}}", mode: "ask", worktreeScope: "thread" },
			{ ...fix, id: "summarize", title: "Summarize {{item}}", mode: "ask", worktreeScope: "workspace" },
		]
		const images = ["data:image/png;base64,AAA"]
		const files = ["/repo/notes.md"]
		await h.runner.start(definition, { tickets: "A-1, A-2" }, { taskGroupId: "parent", context: { images, files } })
		await flush()
		expect(h.started[0]).toMatchObject({ taskGroupId: "parent", worktree: false, images, files })
		expect(h.started[0].worktreeScope).toBeUndefined()
		await h.finish("thread-1", "plan")
		expect(checks).toEqual(["parent", "group-A-1", "group-A-2"])
		for (const scope of ["task", "task", "thread", "workspace"]) {
			const pair = h.started.slice(-2)
			expect(pair).toMatchObject(
				["group-A-1", "group-A-2"].map((taskGroupId) => ({ taskGroupId, worktreeScope: scope, images, files })),
			)
			for (const thread of pair) await h.finish(thread.threadId, "done")
		}
		expect(h.byId("run-1").status).toBe("done")
	})

	it("prechecks unfinished items against their existing worktrees when resuming a fan-out", async () => {
		const definition = fanOut()
		definition.steps[2] = { ...(definition.steps[2] as AutomationThreadStep), worktreeScope: "task" }
		const worktrees = new Set<string>()
		const checks: [string | undefined, string[]][] = []
		const h = harness({
			precheck: (steps, taskGroupId) => {
				checks.push([taskGroupId, steps.map((step) => step.id)])
				return precheckSteps(steps, {
					workspace: "/repo",
					reuseTaskWorktree: !!taskGroupId && worktrees.has(taskGroupId),
					worktrees: async () => ({ available: false, reason: "Worktrees are off." }),
				})
			},
		})
		await h.runner.start(definition, { tickets: "A-1, A-2" }, { taskGroupId: "parent" })
		await flush()
		worktrees.add("group-A-1")
		await h.finish("thread-1", "plan")
		expect(h.started.at(-1)).toMatchObject({ taskGroupId: "group-A-1", worktreeScope: "task" })
		await h.finish("thread-2", "fixed A-1")
		const failedItem = h.byId("run-1").steps[1].items?.[1]
		expect(h.byId(failedItem?.runId as string)).toMatchObject({ status: "failed", fix: "worktrees" })
		expect(failedItem?.error).toContain("Worktrees are off.")

		worktrees.add("group-A-2")
		checks.length = 0
		await h.runner.resume("run-1", definition)
		await flush()
		expect(checks).toEqual([
			["parent", ["each"]],
			["group-A-2", ["fix"]],
		])
		expect(h.started.slice(2)).toMatchObject([{ taskGroupId: "group-A-2", worktreeScope: "task" }])
		await h.finish("thread-3", "fixed A-2")
		expect(h.byId(failedItem?.runId as string).status).toBe("done")
		expect(h.byId("run-1").status).toBe("done")
	})

	it("treats legacy worktree: true inside For each as a shared task worktree", async () => {
		const h = harness()
		const definition = fanOut()
		definition.steps[2] = { ...(definition.steps[2] as AutomationThreadStep), worktree: true }
		const parsed = parseAutomationFile(
			serializeAutomation(definition).replace("worktree: new", "worktree: true"),
			definition.name,
		)
		expect(parsed.errors).toEqual([])
		await h.runner.start(parsed.definition!, { tickets: "A-1, A-2" })
		await flush()
		await h.finish("thread-1", "plan")
		expect(h.started.slice(1)).toMatchObject([
			{ taskGroupId: "group-A-1", worktree: true, worktreeScope: "task" },
			{ taskGroupId: "group-A-2", worktree: true, worktreeScope: "task" },
		])
		await h.finish("thread-2", "fixed A-1")
		await h.finish("thread-3", "fixed A-2")
	})

	it("runs the steps after it once per item, in each item's task, a few at a time", async () => {
		const h = harness()
		await h.runner.start(fanOut(), { tickets: "A-1, A-2, A-3" }, { context: { text: "Be brief." } })
		await flush()
		await h.finish("thread-1", "the plan")
		const parent = h.byId("run-1")
		expect(parent.steps.map((step) => step.id)).toEqual(["plan", "each"])
		expect(parent.steps[1].items?.map((item) => [item.label, item.status])).toEqual([
			["A-1", "running"],
			["A-2", "running"],
			["A-3", "pending"],
		])
		// Two at a time; each in the task tagged with its ticket, with the item and earlier replies filled in.
		// (The first task is the run's own: it has no Open a task step.)
		expect(h.tasks.slice(1).map((task) => task.ticket)).toEqual(["A-1", "A-2"])
		expect(h.started.slice(1).map((thread) => [thread.taskGroupId, thread.title])).toEqual([
			["group-A-1", "Fix A-1"],
			["group-A-2", "Fix A-2"],
		])
		expect(h.started[1].prompt).toBe("Fix A-1 using the plan.\n\n## Context from you\n\nBe brief.")
		const itemRun = h.runs().find((run) => run.parent?.item === "A-1") as AutomationRun
		expect(itemRun.taskGroupId).toBe("group-A-1")
		expect(itemRun.parent).toMatchObject({ runId: "run-1", stepId: "each", index: 0, total: 3 })
		expect(itemRun.steps.map((step) => step.id)).toEqual(["fix"])

		await h.finish("thread-2", "fixed A-1")
		expect(h.started.at(-1)?.title).toBe("Fix A-3")
		await h.finish("thread-3", "fixed A-2")
		await h.finish("thread-4", "fixed A-3")
		const done = h.byId("run-1")
		expect(done.status).toBe("done")
		expect(done.steps[1].items?.every((item) => item.status === "done")).toBe(true)
	})

	it("lets the others finish when one fails, then Retry goes on with only that one", async () => {
		let failB = true
		const h = harness({ failStart: (input) => failB && input.title === "Fix B-2" })
		await h.runner.start(fanOut(), { tickets: "B-1\nB-2\nB-3" })
		await flush()
		await h.finish("thread-1", "plan")
		await h.finish("thread-2", "fixed B-1")
		await h.finish("thread-3", "fixed B-3")
		const failed = h.byId("run-1")
		expect(failed.status).toBe("failed")
		expect(failed.steps[1].status).toBe("failed")
		expect(failed.steps[1].error).toBe("1 of 3 items didn't finish. Retry goes on with only that one.")
		expect(failed.steps[1].items?.map((item) => item.status)).toEqual(["done", "failed", "done"])
		const failedItem = failed.steps[1].items?.[1]
		expect(failedItem?.error).toBe("Couldn't start Fix B-2")

		failB = false
		const startedBefore = h.started.length
		await h.runner.resume("run-1", fanOut())
		await flush()
		// Only B-2 runs again, in its earlier run and task.
		expect(h.started.slice(startedBefore).map((thread) => [thread.title, thread.taskGroupId])).toEqual([
			["Fix B-2", "group-B-2"],
		])
		expect(h.started.at(-1)?.prompt).toBe("Fix B-2 using plan.")
		await h.finish(h.started.at(-1)?.threadId as string, "fixed B-2")
		expect(h.byId("run-1").status).toBe("done")
		expect(h.byId(failedItem?.runId as string).status).toBe("done")
	})

	it("an item's run retried on its own task page completes the fan-out", async () => {
		let fail = true
		let checkedTask: string | undefined
		const h = harness({
			failStart: (input) => fail && input.title === "Fix C-2",
			precheck: async (_steps, taskGroupId) => {
				checkedTask = taskGroupId
				return []
			},
		})
		const definition = fanOut()
		definition.steps[2] = { ...(definition.steps[2] as AutomationThreadStep), worktreeScope: "task" }
		await h.runner.start(definition, { tickets: "C-1, C-2" })
		await flush()
		await h.finish("thread-1", "plan")
		await h.finish("thread-2", "fixed C-1")
		const itemRunId = h.byId("run-1").steps[1].items?.[1].runId as string
		expect(h.byId(itemRunId).status).toBe("failed")
		fail = false
		await h.runner.resume(itemRunId, definition)
		await flush()
		expect(checkedTask).toBe("group-C-2")
		expect(h.started.at(-1)).toMatchObject({ prompt: "Fix C-2 using plan.", taskGroupId: "group-C-2", worktreeScope: "task" })
		await h.finish(h.started.at(-1)?.threadId as string, "fixed C-2")
		expect(h.byId(itemRunId).status).toBe("done")
		expect(h.byId("run-1").status).toBe("done")
	})

	it("Stop stops every item's thread and skips the ones not started", async () => {
		const h = harness()
		await h.runner.start(fanOut({ steps: fanOut().steps.slice(1) }), { tickets: "D-1, D-2, D-3" })
		await flush()
		expect(h.started.map((thread) => thread.title)).toEqual(["Fix D-1", "Fix D-2"])
		await h.runner.stop("run-1")
		await flush()
		expect(h.stopped.sort()).toEqual(["thread-1", "thread-2"])
		const parent = h.byId("run-1")
		expect(parent.status).toBe("stopped")
		expect(parent.steps[0].items?.map((item) => item.status)).toEqual(["stopped", "stopped", "skipped"])
		expect(
			h
				.runs()
				.filter((run) => run.parent)
				.every((run) => run.status === "stopped"),
		).toBe(true)
	})

	it("counts the items' spend toward the run's cost limit", async () => {
		const costs: Record<string, number> = {}
		const h = harness({ threadCost: (id) => costs[id] })
		await h.runner.start(fanOut({ costLimit: 1, steps: fanOut().steps.slice(1) }), { tickets: "E-1, E-2" })
		await flush()
		costs["thread-1"] = 0.6
		costs["thread-2"] = 0.6
		h.runner.threadStatusChanged("thread-1", "running", () => [])
		await flush()
		const parent = h.byId("run-1")
		expect(parent.status).toBe("stopped")
		expect(parent.error).toMatch(/cost limit/)
		expect(h.stopped.sort()).toEqual(["thread-1", "thread-2"])
	})

	it("fails with a plain reason when the list is empty or too long", async () => {
		const h = harness()
		await h.runner.start(fanOut({ steps: fanOut().steps.slice(1) }), { tickets: " , " })
		await flush()
		expect(h.byId("run-1").steps[0].error).toMatch(/The list to go through is empty/)
		const many = Array.from({ length: 21 }, (_, i) => `F-${i}`).join(",")
		await h.runner.start(fanOut({ steps: fanOut().steps.slice(1) }), { tickets: many })
		await flush()
		expect(h.byId("run-2").steps[0].error).toBe("That's 21 items; a run goes through at most 20. Shorten the list.")
	})
})
