import type { AutomationDefinition } from "@shared/automations"

/** "Ticket to PR": every step kind, placeholders and a parallel group. Shared by the automation tests. */
export function ticketToPr(): AutomationDefinition {
	return {
		name: "ticket-to-pr",
		title: "Ticket to PR",
		description: "Ticket to a change you can review",
		arguments: [
			{ name: "ticket", kind: "ticket", required: true, description: "The ticket key" },
			{ name: "base", kind: "branch", required: false, description: "Branch to start from", default: "main" },
		],
		steps: [
			{ kind: "task", id: "task", title: "Open the task", ticket: "{{ticket}}", newTaskTitle: "" },
			{
				kind: "thread",
				id: "research",
				title: "Research {{ticket}}",
				prompt: "Read {{ticket}} and the code it touches.",
				model: "Sonnet 5.5",
				level: "medium",
				mode: "ask",
				worktree: false,
			},
			{
				kind: "together",
				id: "plan",
				title: "Plan",
				prompt: "Plan a fix for {{ticket}} using:\n\n{{steps.research}}",
				threads: [
					{ id: "plan-a", title: "Plan A", prompt: "", model: "Opus 5.5", level: "high", mode: "ask", worktree: false },
					{
						id: "plan-b",
						title: "Plan B",
						prompt: "## Different\nPlan it differently: {{steps.research}}",
						model: "GPT-6.1",
						level: "high",
						mode: "ask",
						worktree: false,
					},
				],
			},
			{
				kind: "checkpoint",
				id: "pick",
				title: "Pick a plan",
				question: "Which plan should Build use?",
				choicesFrom: "plan",
				choices: [],
			},
			{
				kind: "thread",
				id: "build",
				title: "Build {{ticket}}",
				prompt: "Build this plan from {{base}}:\n\n{{steps.pick}}",
				model: "",
				level: "",
				mode: "act",
				worktree: true,
			},
		],
	}
}
