import {
	type AutomationDefinition,
	automationArgsAsOptions,
	blankStep,
	fillPlaceholders,
	placeholderRefs,
	placesContext,
	splitEachItems,
	uniqueStepId,
	validateAutomation,
} from "@shared/automations"
import { parseTypedOptions } from "@shared/scripts"
import { describe, expect, it } from "vitest"
import { parseAutomationFile, serializeAutomation } from "./automation-file"
import { ticketToPr } from "./automation-fixtures"

describe("automation file", () => {
	it("round-trips every step kind through the readable file", () => {
		const definition = ticketToPr()
		const parsed = parseAutomationFile(serializeAutomation(definition), "fallback")
		expect(parsed.errors).toEqual([])
		expect(parsed.definition).toEqual(definition)
	})

	it("round-trips named outputs and checks references across thread and together steps", () => {
		const definition = ticketToPr()
		const [, research, together, , build] = definition.steps
		if (research.kind !== "thread" || together.kind !== "together" || build.kind !== "thread")
			throw new Error("fixture changed")
		definition.keepNotes = true
		research.outputs = [{ name: "findings", description: "Findings: What you learned", saveAsNote: true }]
		together.threads[0].outputs = [{ name: "risk_1", description: "The highest risk" }]
		build.prompt = "Use {{steps.research.findings}} and {{steps.plan-a.risk_1}}."
		const parsed = parseAutomationFile(serializeAutomation(definition), "fallback")
		expect(parsed.definition).toEqual(definition)
		build.prompt = "Use {{steps.plan-a.missing}}."
		expect(validateAutomation(definition)).toContainEqual({
			at: build.id,
			message: "{{steps.plan-a.missing}} isn't a declared output",
		})
	})

	it("writes a file a person can read: a heading per step, meta lines, then the prompt", () => {
		const text = serializeAutomation(ticketToPr())
		expect(text).toContain("# Ticket to PR")
		expect(text).toContain(
			"## Research {{ticket}}\n- id: research\n- kind: thread\n- model: Sonnet 5.5\n- level: medium\n- mode: ask\n\nRead {{ticket}} and the code it touches.",
		)
		expect(text).toContain("### Plan A\n- id: plan-a\n- model: Opus 5.5")
		expect(text).toContain("## Pick a plan\n- id: pick\n- kind: checkpoint\n- choices from: plan")
		expect(text).toContain("- worktree: new")
		// A prompt with its own heading is fenced, so it can't start a new step.
		expect(text).toContain("````text\n## Different\nPlan it differently: {{steps.research}}\n````")
	})

	it("lists problems instead of a definition for a broken file", () => {
		const parsed = parseAutomationFile("---\nname: Bad Name\n---\n\n## Go\n- kind: thread\n", "bad")
		expect(parsed.definition).toBeUndefined()
		expect(parsed.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Name must be lowercase"),
				expect.stringContaining("Add a description"),
				expect.stringContaining("Write the prompt"),
			]),
		)
		expect(parseAutomationFile("no frontmatter", "x").errors[0]).toContain("Missing YAML frontmatter")
	})

	it("rejects a ### thread outside a together step and an unknown kind", () => {
		const parsed = parseAutomationFile(
			"---\nname: x\ndescription: d\n---\n\n### Stray\n\nHi\n\n## Odd\n- kind: dance\n\nHi\n\n## Ok\n\nHello\n",
			"x",
		)
		expect(parsed.errors).toEqual([
			'"### Stray" must sit under a together step',
			'Step "Odd": kind must be one of task, thread, together, checkpoint, each',
		])
	})
})

describe("validateAutomation", () => {
	it("accepts the example", () => {
		expect(validateAutomation(ticketToPr())).toEqual([])
	})

	it("refuses a name that is already a built-in command", () => {
		const messages = validateAutomation({ ...ticketToPr(), name: "skill" }).map((issue) => issue.message)
		expect(messages).toContain("/skill is already a Cline command; pick another name")
	})

	it("catches placeholders that point nowhere or later, and misplaced steps", () => {
		const definition = ticketToPr()
		const [task, research, plan] = definition.steps
		if (research.kind !== "thread" || plan.kind !== "together") throw new Error("fixture changed")
		research.prompt = "Use {{steps.plan}} and {{missing}} and {{steps.nope}}"
		definition.steps = [research, task, plan]
		const messages = validateAutomation(definition).map((issue) => issue.message)
		expect(messages).toEqual(
			expect.arrayContaining([
				"{{steps.plan}} runs later, so it has no reply yet",
				"{{missing}} isn't an argument",
				"{{steps.nope}} isn't a step",
				"Open a task must be the first step",
			]),
		)
	})

	it("needs two threads to run together and an earlier group for a checkpoint's choices", () => {
		const definition = ticketToPr()
		const plan = definition.steps[2]
		if (plan.kind !== "together") throw new Error("fixture changed")
		plan.threads = plan.threads.slice(0, 1)
		const pick = definition.steps[3]
		if (pick.kind !== "checkpoint") throw new Error("fixture changed")
		pick.choicesFrom = "research"
		const messages = validateAutomation(definition).map((issue) => issue.message)
		expect(messages).toContain("Threads together needs at least 2 threads")
		expect(messages).toContain("Choices must come from an earlier Threads together step")
	})
})

describe("placeholders", () => {
	it("finds argument and step references", () => {
		expect(placeholderRefs("{{ ticket }} then {{steps.plan-a}}")).toEqual([
			{ raw: "{{ ticket }}", kind: "arg", name: "ticket" },
			{ raw: "{{steps.plan-a}}", kind: "step", name: "plan-a" },
		])
	})

	it("fills arguments and earlier replies; unknown ones become empty", () => {
		expect(
			fillPlaceholders("Fix {{ticket}}: {{steps.plan}}{{steps.gone}}", {
				args: { ticket: "PROJ-1" },
				outputs: { plan: "the plan" },
			}),
		).toBe("Fix PROJ-1: the plan")
	})
})

describe("builder helpers", () => {
	it("makes unique ids and blank steps", () => {
		const steps = [blankStep("thread", [])]
		expect(steps[0].id).toBe("thread")
		expect(uniqueStepId("thread", steps)).toBe("thread-2")
		const together = blankStep("together", steps)
		expect(together.kind === "together" && together.threads.map((thread) => thread.id)).toEqual(["together-a", "together-b"])
	})

	it("turns arguments into typed options the composer parser understands", () => {
		const options = automationArgsAsOptions(ticketToPr().arguments)
		const parsed = parseTypedOptions("ticket:PROJ-142 ", options, { final: true })
		expect(parsed.values).toEqual({ ticket: "PROJ-142" })
		expect(parsed.missing).toEqual([])
		expect(parseTypedOptions("", options, { final: true }).missing.map((option) => option.name)).toEqual(["ticket"])
	})
})

describe("For each and context", () => {
	const fanOut = (): AutomationDefinition => ({
		...ticketToPr(),
		arguments: [{ name: "tickets", kind: "text", required: true, description: "Tickets" }],
		steps: [
			{
				kind: "each",
				id: "each",
				title: "Each ticket",
				items: "{{tickets}}",
				ticket: "{{item}}",
				newTaskTitle: "",
				atOnce: 4,
			},
			{
				kind: "thread",
				id: "fix",
				title: "Fix {{item}}",
				prompt: "Fix {{item}}. {{context}}",
				model: "",
				level: "",
				mode: "act",
				worktree: true,
			},
		],
	})

	it("round-trips a For each step through the readable file", () => {
		const text = serializeAutomation(fanOut())
		expect(text).toContain("- kind: each\n- items: {{tickets}}\n- ticket: {{item}}\n- at once: 4")
		const parsed = parseAutomationFile(text, "x")
		expect(parsed.errors).toEqual([])
		expect(parsed.definition).toEqual(fanOut())
	})

	it("allows {{context}} anywhere and {{item}} only from For each on", () => {
		expect(validateAutomation(fanOut())).toEqual([])
		const early = fanOut()
		early.steps.unshift({
			kind: "thread",
			id: "pre",
			title: "Pre",
			prompt: "Look at {{item}}",
			model: "",
			level: "",
			mode: "ask",
			worktree: false,
		})
		expect(validateAutomation(early).map((issue) => issue.message)).toEqual([
			"{{item}} only has a value in a For each step and the steps after it",
		])
	})

	it("checks a For each step: a list, steps after it, only one, and how many at once", () => {
		const bad = fanOut()
		bad.steps = [{ kind: "each", id: "each", title: "Each", items: "", ticket: "", newTaskTitle: "", atOnce: 12 }]
		expect(validateAutomation(bad).map((issue) => issue.message)).toEqual([
			"Add the steps to run for each item after it",
			"Say which list to go through, like {{tickets}}",
			"Run 1 to 8 items at once",
		])
		const twice = fanOut()
		twice.steps.push({
			kind: "each",
			id: "again",
			title: "Again",
			items: "{{tickets}}",
			ticket: "",
			newTaskTitle: "",
			atOnce: 1,
		})
		expect(validateAutomation(twice).map((issue) => issue.message)).toContain(
			"Only one For each step: put every per-item step after the first",
		)
	})

	it("reserves the context and item names for arguments", () => {
		const definition = fanOut()
		definition.arguments.push({ name: "context", kind: "text", required: false, description: "" })
		expect(validateAutomation(definition).map((issue) => issue.message)).toContain(
			'"context" is reserved: {{context}} is filled in for you',
		)
	})

	it("splits a list from lines, JSON, or commas", () => {
		expect(splitEachItems("- A-1\n- A-2\n\n3. A-3")).toEqual(["A-1", "A-2", "A-3"])
		expect(splitEachItems('["a b", "c", "a b"]')).toEqual(["a b", "c"])
		expect(splitEachItems("A-1, A-2 ,A-3")).toEqual(["A-1", "A-2", "A-3"])
		expect(splitEachItems("one, two\nthree")).toEqual(["one, two", "three"])
		expect(splitEachItems("  ")).toEqual([])
	})

	it("knows whether the automation places the context itself", () => {
		expect(placesContext(fanOut().steps)).toBe(true)
		expect(placesContext(ticketToPr().steps)).toBe(false)
	})
})
