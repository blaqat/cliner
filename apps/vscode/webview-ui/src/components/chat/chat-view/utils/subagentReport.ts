import type { ClineMessage } from "@shared/ExtensionMessage"

/** Keep complete Markdown, including code fences, when quoting a child's report. */
export function subagentReportText(messages: readonly ClineMessage[]): string {
	return messages
		.filter(
			(message) =>
				message.type === "say" &&
				(message.say === "text" || message.say === "completion_result" || message.say === "plan_completion_result"),
		)
		.map((message) => message.text ?? "")
		.join("\n\n")
}
