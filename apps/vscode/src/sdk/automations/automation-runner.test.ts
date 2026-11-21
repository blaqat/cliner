import type { AutomationRun } from "@shared/automations"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { ticketToPr } from "./automation-fixtures"
import {
	AutomationCheckError,
	AutomationFixableError,
	AutomationRunner,
	type AutomationRunnerDeps,
	classifyTurnEnd,
	type StartThreadInput,
	type StoredAutomationRun,
} from "./automation-runner"

const say = (sayKind: string, text: string): ClineMessage => ({ ts: 1, type: "say", say: sayKind as never, text })
const ask = (askKind: string, text: string): ClineMessage => ({ ts: 1, type: "ask", ask: askKind as never, text })

/** Lets the runner's awaits settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(
	definition = ticketToPr(),
	overrides: Partial<Omit<AutomationRunnerDeps, "startThread">> & {
		/** Runs before the thread starts; throw to fail it. */
		startThread?: (input: StartThreadInput) => Promise<void>
	} = {},
) {
	const started: (StartThreadInput & { threadId: string })[] = []
	const stopped: string[] = []
	const tasks: { ticket?: string; title: string }[] = []
	let latest: readonly AutomationRun[] = []
	let saved: readonly StoredAutomationRun[] = []
	let n = 0
	const runner = new AutomationRunner({
		findOrCreateTask: async (ticket, title) => {
			tasks.push({ ticket, title })
			return `group-${ticket}`
		},
		createTask: async (title, ticket) => {
			tasks.push({ title, ticket })
			return "group-new"
		},
		startThread: async (input) => {
			await overrides.startThread?.(input)
			const threadId = `thread-${++n}`
			started.push({ ...input, threadId })
			return threadId
		},
		stopThread: async (id) => {
			stopped.push(id)
		},
		precheck: overrides.precheck,
		describeWaiting: overrides.describeWaiting,
		threadCost: overrides.threadCost,
		onChange: (runs) => {
			latest = runs
		},
		save: async (runs) => {
			saved = runs
		},
		load: overrides.load,
		newId: () => "run-1",
		now: () => 1000,
	})
	/** The thread's turn ended with this reply. */
	const finish = async (threadId: string, reply: string) => {
		runner.threadStatusChanged(threadId, "done", () => [say("completion_result", reply)])
		await flush()
	}
	return {
		runner,
		definition,
		started,
		stopped,
		tasks,
		finish,
		run: () => latest[latest.length - 1],
		saved: () => saved,
	}
}

describe("classifyTurnEnd", () => {
	it("uses the last reply: a completion, an Ask-mode response or plain text", () => {
		expect(classifyTurnEnd([say("text", "early"), say("completion_result", "Done.")])).toEqual({
			kind: "done",
			reply: "Done.",
		})
		expect(classifyTurnEnd([ask("plan_mode_respond", JSON.stringify({ response: "The plan" }))])).toEqual({
			kind: "done",
			reply: "The plan",
		})
		expect(classifyTurnEnd([say("text", "Answer"), say("api_req_started", "{}")])).toEqual({ kind: "done", reply: "Answer" })
	})

	it("treats a question for the user as waiting", () => {
		expect(classifyTurnEnd([say("text", "Hm"), ask("followup", JSON.stringify({ question: "Which?" }))])).toEqual({
			kind: "waiting",
		})
	})
})

describe("AutomationRunner", () => {
	it("runs Ticket to PR: task, thread, two threads together, a pick, then a worktree build", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-142" })
		await flush()
		expect(h.tasks).toEqual([{ ticket: "PROJ-142", title: "PROJ-142" }])
		expect(h.started).toHaveLength(1)
		expect(h.started[0]).toMatchObject({
			taskGroupId: "group-PROJ-142",
			title: "Research PROJ-142",
			prompt: "Read PROJ-142 and the code it touches.",
			model: "Sonnet 5.5",
			level: "medium",
			mode: "ask",
			worktree: false,
		})

		await h.finish("thread-1", "502s come from the gateway.")
		// Both plans start at once; Plan A gets the group's prompt, Plan B its own.
		expect(h.started.map((thread) => thread.title)).toEqual(["Research PROJ-142", "Plan A", "Plan B"])
		expect(h.started[1].prompt).toBe("Plan a fix for PROJ-142 using:\n\n502s come from the gateway.")
		expect(h.started[2].prompt).toBe("## Different\nPlan it differently: 502s come from the gateway.")
		expect(h.run().steps[2].threads.map((thread) => thread.status)).toEqual(["running", "running"])

		await h.finish("thread-3", "Plan B: jitter")
		expect(h.run().steps[2].status).toBe("running")
		await h.finish("thread-2", "Plan A: retry 5 times")

		// The checkpoint offers the group's threads and waits.
		expect(h.run().status).toBe("waiting")
		expect(h.run().steps[3]).toMatchObject({ status: "waiting", choices: ["Plan A", "Plan B"] })
		expect(() => h.runner.answer("run-1", "pick", "Plan C")).toThrow("Pick one of")
		h.runner.answer("run-1", "pick", "Plan A")
		await flush()

		// Build gets the picked thread's reply and the base default.
		expect(h.started[3]).toMatchObject({
			title: "Build PROJ-142",
			prompt: "Build this plan from main:\n\nPlan A: retry 5 times",
			mode: "act",
			worktree: true,
			model: "",
		})
		await h.finish("thread-4", "Built it.")
		expect(h.run().status).toBe("done")
		expect(h.run().steps.map((step) => step.status)).toEqual(["done", "done", "done", "done", "done"])
		expect(h.run().steps[4].threads[0]).toMatchObject({ threadId: "thread-4", reply: "Built it." })
		expect(h.saved().at(-1)?.status).toBe("done")
	})

	it("makes a task named after the automation when it has no task step and none was given", async () => {
		const definition = ticketToPr()
		definition.steps = definition.steps.slice(1, 2)
		const h = harness(definition)
		await h.runner.start(definition, { ticket: "PROJ-7" })
		expect(h.tasks).toEqual([{ title: "Ticket to PR · PROJ-7", ticket: "PROJ-7" }])
		expect(h.run().taskGroupId).toBe("group-new")

		const inTask = harness(definition)
		await inTask.runner.start(definition, { ticket: "PROJ-7" }, { taskGroupId: "mine" })
		await flush()
		expect(inTask.tasks).toEqual([])
		expect(inTask.started[0].taskGroupId).toBe("mine")
	})

	it("refuses to start without required arguments", async () => {
		const h = harness()
		await expect(h.runner.start(h.definition, {})).rejects.toThrow("Needs ticket")
	})

	it("waits while a thread asks the user something, then goes on", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-1" })
		await flush()
		h.runner.threadStatusChanged("thread-1", "done", () => [ask("followup", JSON.stringify({ question: "Which repo?" }))])
		expect(h.run().steps[1].threads[0].status).toBe("waiting")
		expect(h.started).toHaveLength(1)
		await h.finish("thread-1", "Found it")
		expect(h.started).toHaveLength(3)
	})

	it("a turn the user cancelled in the thread waits for them instead of finishing the step", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-1" })
		await flush()
		h.runner.threadStatusChanged(
			"thread-1",
			"done",
			() => [say("text", "half an answer")],
			() => true,
		)
		await flush()
		expect(h.run().steps[1].threads[0].status).toBe("waiting")
		expect(h.started).toHaveLength(1)
		await h.finish("thread-1", "The whole answer")
		expect(h.started[1].prompt).toContain("The whole answer")
	})

	it("waits on a thread that hit an error, so retrying it in the thread goes on", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-1" })
		await flush()
		h.runner.threadStatusChanged("thread-1", "error", () => [])
		await flush()
		expect(h.run().status).toBe("waiting")
		expect(h.run().steps[1].threads[0]).toMatchObject({ status: "waiting", waitingOn: expect.stringContaining("Retry") })
		await h.finish("thread-1", "Findings after a retry")
		expect(h.run().status).toBe("running")
		expect(h.started).toHaveLength(3)
	})

	it("says what a waiting thread needs, from its pending approval", async () => {
		const h = harness(undefined, { describeWaiting: () => "Approve a command: npm test" })
		await h.runner.start(h.definition, { ticket: "PROJ-1" })
		await flush()
		h.runner.threadStatusChanged("thread-1", "waiting", () => [])
		expect(h.run().status).toBe("waiting")
		expect(h.run().steps[1].threads[0].waitingOn).toBe("Approve a command: npm test")
		h.runner.threadStatusChanged("thread-1", "running", () => [])
		expect(h.run().status).toBe("running")
		expect(h.run().steps[1].threads[0].waitingOn).toBeUndefined()
	})

	it("fails the step a thread can't start in, saying why and where to fix it, and skips the rest", async () => {
		const h = harness(undefined, {
			startThread: async () => {
				throw new AutomationFixableError("Couldn't make its worktree: worktrees are turned off.", "worktrees")
			},
		})
		await h.runner.start(h.definition, { ticket: "PROJ-1" })
		await flush()
		expect(h.run().status).toBe("failed")
		expect(h.run().error).toBeUndefined()
		expect(h.run().steps[1]).toMatchObject({ status: "failed", fix: "worktrees" })
		expect(h.run().steps[1].threads[0]).toMatchObject({
			status: "failed",
			error: "Couldn't make its worktree: worktrees are turned off.",
			fix: "worktrees",
		})
		expect(h.run().steps.map((step) => step.status)).toEqual(["done", "failed", "skipped", "skipped", "skipped"])
	})

	it("checks the workspace before anything runs", async () => {
		const h = harness(undefined, {
			precheck: async () => [{ message: "“Build” runs in a new worktree, but worktrees are off.", fix: "worktrees" }],
		})
		await expect(h.runner.start(h.definition, { ticket: "PROJ-1" })).rejects.toBeInstanceOf(AutomationCheckError)
		expect(h.tasks).toEqual([])
		expect(h.started).toEqual([])
		expect(h.run()).toBeUndefined()
	})

	it("retries the failed step after the cause is fixed, keeping finished steps and their replies", async () => {
		let failBuild = true
		const definition = ticketToPr()
		const h = harness(definition, {
			startThread: async (input) => {
				if (input.worktree && failBuild) throw new AutomationFixableError("Couldn't make its worktree.", "worktrees")
			},
		})
		await h.runner.start(definition, { ticket: "PROJ-9" })
		await flush()
		await h.finish("thread-1", "Research notes")
		await h.finish("thread-2", "Plan A text")
		await h.finish("thread-3", "Plan B text")
		h.runner.answer("run-1", "pick", "Plan B")
		await flush()
		expect(h.run().status).toBe("failed")
		expect(h.run().steps[4].status).toBe("failed")

		failBuild = false
		await h.runner.resume("run-1", definition)
		await flush()
		// Only Build ran again, with the picked plan's full reply.
		expect(h.started.at(-1)).toMatchObject({ title: "Build PROJ-9", prompt: "Build this plan from main:\n\nPlan B text" })
		expect(
			h
				.run()
				.steps.slice(0, 4)
				.map((step) => step.status),
		).toEqual(["done", "done", "done", "done"])
		expect(h.run().steps[1].threads[0].threadId).toBe("thread-1")
		expect(h.run()).toMatchObject({ id: "run-1", status: "running", resumedAt: 1000 })
		const buildThread = h.run().steps[4].threads[0].threadId as string
		await h.finish(buildThread, "Built.")
		expect(h.run().status).toBe("done")
	})

	it("resumes from an earlier step, running it and everything after it again", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-2" })
		await flush()
		await h.finish("thread-1", "Notes v1")
		await h.runner.stop("run-1")
		await flush()
		await expect(h.runner.resume("run-1", h.definition, "build")).rejects.toThrow("can't run yet")
		await h.runner.resume("run-1", h.definition, "research")
		await flush()
		expect(h.started.at(-1)?.title).toBe("Research PROJ-2")
		expect(h.run().steps[2].status).toBe("pending")
	})

	it("retrying a together step keeps the threads that replied", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-3" })
		await flush()
		await h.finish("thread-1", "Notes")
		await h.finish("thread-2", "Plan A text")
		await h.runner.stop("run-1")
		await flush()
		const before = h.started.length
		await h.runner.resume("run-1", h.definition)
		await flush()
		expect(h.started.slice(before).map((thread) => thread.title)).toEqual(["Plan B"])
		expect(h.run().steps[2].threads[0]).toMatchObject({ status: "done", threadId: "thread-2" })
	})

	it("reserves a resume while precheck awaits and releases it when precheck fails", async () => {
		let check: (() => Promise<never[]>) | undefined
		const h = harness(undefined, { precheck: () => check?.() ?? Promise.resolve([]) })
		await h.runner.start(h.definition, { ticket: "PROJ-3" })
		await flush()
		await h.runner.stop("run-1")
		await flush()
		let rejectCheck!: (error: Error) => void
		check = () =>
			new Promise((_, reject) => {
				rejectCheck = reject
			})
		const first = h.runner.resume("run-1", h.definition)
		await flush()
		const duplicate = h.runner.resume("run-1", h.definition)
		await expect(duplicate).rejects.toThrow("already running")
		rejectCheck(new Error("precheck failed"))
		await expect(first).rejects.toThrow("precheck failed")
		check = undefined
		await h.runner.resume("run-1", h.definition)
		await flush()
		expect(h.started).toHaveLength(2)
		await h.runner.stop("run-1")
	})

	it.each(["go back", "run again"])("reruns every thread of a completed final together step on %s", async (action) => {
		const definition = ticketToPr()
		definition.steps = definition.steps.slice(2, 3)
		const h = harness(definition)
		await h.runner.start(definition, { ticket: "PROJ-3" })
		await flush()
		await h.finish("thread-1", "A")
		await h.finish("thread-2", "B")
		expect(h.run().status).toBe("done")
		if (action === "go back") await h.runner.resume("run-1", definition, definition.steps[0].id)
		else {
			;(h.runner as unknown as { deps: { newId: () => string } }).deps.newId = () => "run-2"
			await h.runner.runAgain("run-1", definition)
		}
		await flush()
		expect(h.started.slice(2).map((thread) => thread.title)).toEqual(["Plan A", "Plan B"])
		await h.runner.stop(h.run().id)
	})

	it("explicitly going back to a stopped together step reruns its finished threads too", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-3" })
		await flush()
		await h.finish("thread-1", "Notes")
		await h.finish("thread-2", "A")
		await h.runner.stop("run-1")
		await flush()
		await h.runner.resume("run-1", h.definition, h.definition.steps[2].id)
		await flush()
		expect(h.started.slice(3).map((thread) => thread.title)).toEqual(["Plan A", "Plan B"])
		await h.runner.stop("run-1")
	})

	it("resumes after VS Code restarts, from the replies kept on disk", async () => {
		const first = harness()
		await first.runner.start(first.definition, { ticket: "PROJ-4" })
		await flush()
		await first.finish("thread-1", "Kept research")
		const stored = first.saved()
		expect(stored.at(-1)?.outputs?.research).toBe("Kept research")

		const started: StartThreadInput[] = []
		const runner = new AutomationRunner({
			findOrCreateTask: async () => "g",
			createTask: async () => "g",
			startThread: async (input) => {
				started.push(input)
				return `t-${started.length}`
			},
			stopThread: async () => {},
			onChange: () => {},
			load: async () => structuredClone([...stored]),
			now: () => 2000,
		})
		await runner.load()
		expect(runner.list()[0]).toMatchObject({ status: "stopped" })
		await runner.resume("run-1", first.definition)
		await flush()
		expect(started[0].prompt).toBe("Plan a fix for PROJ-4 using:\n\nKept research")
	})

	it("runs again fresh with the same values in the same task", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-5" }, { taskGroupId: "mine" })
		await flush()
		await h.runner.stop("run-1")
		let next = 2
		;(h.runner as unknown as { deps: { newId: () => string } }).deps.newId = () => `run-${next++}`
		const again = await h.runner.runAgain("run-1", h.definition)
		expect(again).toMatchObject({ id: "run-2", values: { ticket: "PROJ-5", base: "main" }, status: "running" })
	})

	it.each([
		{ limit: 1, spent: 1.2, displayLimit: "$1.00", displaySpent: "$1.20" },
		{ limit: 0.001, spent: 0.00123456, displayLimit: "$0.001", displaySpent: "$0.001235" },
	])("stops at a $displayLimit cost limit and allows it again on resume", async ({
		limit,
		spent,
		displayLimit,
		displaySpent,
	}) => {
		const definition = { ...ticketToPr(), costLimit: limit }
		const costs: Record<string, number> = {}
		const h = harness(definition, { threadCost: (id) => costs[id] })
		await h.runner.start(definition, { ticket: "PROJ-6" })
		await flush()
		costs["thread-1"] = limit / 2
		h.runner.threadStatusChanged("thread-1", "running", () => [])
		expect(h.run().status).toBe("running")
		costs["thread-1"] = spent
		h.runner.threadStatusChanged("thread-1", "running", () => [])
		await flush()
		expect(h.run().status).toBe("stopped")
		expect(h.run().error).toBe(
			`Stopped at its ${displayLimit} cost limit (${displaySpent} spent). Resume to allow another ${displayLimit}.`,
		)
		expect(h.stopped).toEqual(["thread-1"])
		await h.runner.resume("run-1", definition)
		await flush()
		expect(h.run().status).toBe("running")
	})

	it("restores the exact sub-cent limit in a saved stop message", async () => {
		const h = harness(undefined, {
			load: async () => [
				{
					id: "legacy",
					title: "Cost test",
					automation: "cost-test",
					taskGroupId: "task",
					values: {},
					steps: [],
					status: "stopped",
					startedAt: 1,
					endedAt: 2,
					costLimit: 0.001,
					error: "Stopped at its $0.00 cost limit ($0.00 spent). Resume to allow another $0.00.",
				},
			],
		})
		await h.runner.load()
		expect(h.runner.list()[0].error).toBe(
			"Stopped at its $0.001 cost limit (less than $0.01 spent). Resume to allow another $0.001.",
		)
	})

	it("stops running threads and keeps what finished", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-1" })
		await flush()
		await h.finish("thread-1", "Findings")
		await h.runner.stop("run-1")
		await flush()
		expect(h.stopped.sort()).toEqual(["thread-2", "thread-3"])
		expect(h.run().status).toBe("stopped")
		expect(h.run().error).toBeUndefined()
		expect(h.run().steps.map((step) => step.status)).toEqual(["done", "done", "stopped", "skipped", "skipped"])
		expect(h.started).toHaveLength(3)
	})

	it("stops at a checkpoint without starting anything else", async () => {
		const h = harness()
		await h.runner.start(h.definition, { ticket: "PROJ-1" })
		await flush()
		await h.finish("thread-1", "Findings")
		await h.finish("thread-2", "A")
		await h.finish("thread-3", "B")
		await h.runner.stop("run-1")
		await flush()
		expect(h.run().status).toBe("stopped")
		expect(h.run().steps[3].status).toBe("stopped")
		expect(h.started).toHaveLength(3)
	})

	it("shows a run that was going when VS Code closed as stopped", async () => {
		const running: AutomationRun = {
			id: "old",
			automation: "x",
			title: "X",
			values: {},
			taskGroupId: "g",
			status: "running",
			startedAt: 1,
			steps: [
				{ id: "a", kind: "thread", title: "A", status: "running", threads: [] },
				{ id: "b", kind: "thread", title: "B", status: "pending", threads: [] },
			],
		}
		const runner = new AutomationRunner({
			findOrCreateTask: async () => "",
			createTask: async () => "",
			startThread: async () => "",
			stopThread: async () => {},
			onChange: () => {},
			load: async () => [running],
			now: () => 5,
		})
		await runner.load()
		expect(runner.list()[0]).toMatchObject({ status: "stopped", endedAt: 5 })
		expect(runner.list()[0].steps.map((step) => step.status)).toEqual(["stopped", "skipped"])
	})
})
