import { type AgentTool, createTool } from "@cline/shared"
import type { AutomationOutput } from "@shared/automations"

export interface AutomationOutputContext {
	outputs: AutomationOutput[]
	active: () => boolean
	missing: () => AutomationOutput[]
	record: (name: string, value: string) => void
}

export function automationOutputPrompt(outputs: readonly AutomationOutput[]): string {
	return [
		"Record these outstanding automation outputs before ending your turn. Use this tool for these outputs instead of writing notebook notes.",
		...outputs.map((output) => `- ${output.name}: ${output.description}`),
	].join("\n")
}

export function createAutomationOutputTool(
	context: AutomationOutputContext,
): AgentTool<{ name: string; value: string }, string | { error: string }> {
	return createTool<{ name: string; value: string }, string | { error: string }>({
		name: "automation_output",
		description:
			"Record a named output for this automation step. Later steps can use its full text. Recording the same name again replaces its value.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", enum: context.outputs.map(({ name }) => name) },
				value: { type: "string", description: "Full text of the output" },
			},
			required: ["name", "value"],
		},
		execute: async ({ name, value }, call) => {
			if (call.snapshot?.parentAgentId) return { error: "Only the automation step's thread can record its outputs." }
			if (typeof value !== "string" || !value.trim()) return { error: "Give the output some text." }
			if (value.length > 200_000) return { error: "Keep the output under 200,000 characters." }
			try {
				context.record(name, value)
				return `Recorded "${name}".`
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})
}
