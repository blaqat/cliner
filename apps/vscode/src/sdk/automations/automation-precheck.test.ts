import { describe, expect, it } from "vitest"
import { describeDecision, staysInWorktree } from "./automation-approvals"
import { ticketToPr } from "./automation-fixtures"
import { automationFromTask } from "./automation-from-task"
import { plainWorktreeReason, precheckSteps } from "./automation-precheck"

describe("precheckSteps", () => {
	const steps = ticketToPr().steps

	it("says which steps need a worktree, why one can't be made, and where to fix it", async () => {
		const problems = await precheckSteps(steps, {
			workspace: "/repo",
			worktrees: async () => ({
				available: false,
				reason: "fatal: not a git repository (or any of the parent directories): .git",
			}),
		})
		expect(problems).toEqual([
			{
				message:
					"“Build {{ticket}}” runs in a new worktree, but this folder isn't a git repository. Open the repository's folder, or run git init.",
				stepId: "build",
			},
		])
	})

	it("doesn't look at worktrees when no step needs one, and needs a folder when one does", async () => {
		let asked = false
		const worktrees = async () => {
			asked = true
			return { available: true }
		}
		expect(await precheckSteps(steps.slice(0, 2), { workspace: "/repo", worktrees })).toEqual([])
		expect(asked).toBe(false)
		const [problem] = await precheckSteps(steps, { workspace: undefined, worktrees })
		expect(problem.message).toContain("no folder is open")
	})

	it("adds model problems with the Models fix", async () => {
		const problems = await precheckSteps(steps.slice(1, 2), {
			workspace: "/repo",
			worktrees: async () => ({ available: true }),
			modelProblem: (model) => (model === "Sonnet 5.5" ? "No model called Sonnet 5.5" : undefined),
		})
		expect(problems).toEqual([
			{ message: "“Research {{ticket}}”: No model called Sonnet 5.5", fix: "models", stepId: "research" },
		])
	})

	it("links Worktrees settings only when that's where the fix is", async () => {
		const [problem] = await precheckSteps(steps, {
			workspace: "/repo",
			worktrees: async () => ({ available: false, reason: "Worktrees are off for this workspace" }),
		})
		expect(problem).toMatchObject({ fix: "worktrees", message: expect.stringContaining("turned off") })
	})

	it("puts git's errors in plain words", () => {
		expect(plainWorktreeReason("Worktrees are off for this workspace")).toBe("worktrees are turned off.")
		expect(plainWorktreeReason("fatal: ambiguous argument 'HEAD': unknown revision")).toContain("no commits yet")
		expect(plainWorktreeReason("Set the path to mm.js in Worktrees settings")).toBe("mm isn't set up. Set the path to mm.js.")
	})
})

describe("automation approvals", () => {
	it("approves reads and edits only inside the worktree", () => {
		const wt = "/repo/.worktrees/build-1"
		expect(staysInWorktree("editor", { path: `${wt}/src/a.ts`, new_text: "x" }, wt)).toBe(true)
		expect(staysInWorktree("editor", { path: "src/a.ts", new_text: "x" }, wt)).toBe(true)
		expect(staysInWorktree("editor", { path: "/repo/src/a.ts", new_text: "x" }, wt)).toBe(false)
		expect(staysInWorktree("editor", { path: `${wt}/../../src/a.ts` }, wt)).toBe(false)
		expect(staysInWorktree("read_files", { files: [{ path: `${wt}/a` }, { path: `${wt}/b` }] }, wt)).toBe(true)
		expect(staysInWorktree("read_files", { files: [{ path: `${wt}/a` }, { path: "/etc/passwd" }] }, wt)).toBe(false)
		expect(staysInWorktree("apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }, wt)).toBe(
			true,
		)
		expect(staysInWorktree("apply_patch", { input: "*** Begin Patch\n*** Add File: /tmp/x\n*** End Patch" }, wt)).toBe(false)
		expect(staysInWorktree("search_codebase", { queries: ["foo"] }, wt)).toBe(true)
	})

	it("never approves commands, MCP or the web", () => {
		const wt = "/repo/.worktrees/build-1"
		expect(staysInWorktree("run_commands", { commands: ["ls"] }, wt)).toBe(false)
		expect(staysInWorktree("server__tool", { path: `${wt}/a` }, wt)).toBe(false)
		expect(staysInWorktree("web_fetch", { url: "https://x" }, wt)).toBe(false)
	})

	it("describes what a waiting thread needs", () => {
		expect(describeDecision({ ts: 1, type: "ask", ask: "command", text: "npm test" })).toBe("Approve a command: npm test")
		expect(
			describeDecision({
				ts: 1,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "editedExistingFile", path: "src/a.ts" }),
			}),
		).toBe("Approve an edit to src/a.ts")
		expect(
			describeDecision({ ts: 1, type: "ask", ask: "followup", text: JSON.stringify({ question: "Which database?" }) }),
		).toBe("Answer: Which database?")
		expect(describeDecision(undefined)).toBeUndefined()
	})
})

describe("automationFromTask", () => {
	it("makes a step per thread, joins threads started together with one prompt, and turns the ticket into an argument", () => {
		const { definition, guesses } = automationFromTask({
			title: "PROJ-12 login bug",
			ticket: "PROJ-12",
			threads: [
				{
					title: "Plan PROJ-12",
					prompt: "Plan a fix for PROJ-12",
					startedTs: 0,
					model: "Alpha",
					level: "",
					worktree: false,
				},
				{ title: "Build", prompt: "Build it", startedTs: 200_000, model: "", level: "", worktree: true },
				{
					title: "Review A",
					prompt: "Review the change",
					startedTs: 300_000,
					model: "Alpha",
					level: "high",
					worktree: false,
				},
				{
					title: "Review B",
					prompt: "Review the change",
					startedTs: 300_500,
					model: "Bravo",
					level: "",
					worktree: false,
				},
				// The task ran again: the same prompt on the same model isn't a new step.
				{
					title: "Plan again",
					prompt: "Plan a fix for PROJ-12",
					startedTs: 900_000,
					model: "Alpha",
					level: "",
					worktree: false,
				},
			],
		})
		expect(definition.arguments.map((arg) => arg.name)).toEqual(["ticket"])
		expect(definition.steps.map((step) => step.kind)).toEqual(["thread", "thread", "together"])
		expect(definition.steps[0]).toMatchObject({ title: "Plan {{ticket}}", prompt: "Plan a fix for {{ticket}}", mode: "ask" })
		expect(definition.steps[1]).toMatchObject({ mode: "act", worktree: true })
		expect(definition.steps[2]).toMatchObject({ prompt: "Review the change" })
		expect(definition.name).toBe("login-bug")
		expect(definition.steps[0].id).toBe("plan-ticket")
		expect(guesses.join(" ")).toContain("repeating an earlier one")
		expect(guesses.join(" ")).toContain("{{ticket}}")
	})
})

describe("ticketKey", () => {
	it("finds a short key in pasted text or a URL", async () => {
		const { ticketKey } = await import("@shared/automations")
		expect(ticketKey("PROJ-7 Add a greeting file https://tracker.example/PROJ-7")).toBe("PROJ-7")
		expect(ticketKey("https://github.com/acme/app/issues/42")).toBe("issues 42")
		expect(ticketKey("Fix the login page when the session expires and the user is on mobile")).toBe(
			"Fix the login page when the session exp…",
		)
	})
})
