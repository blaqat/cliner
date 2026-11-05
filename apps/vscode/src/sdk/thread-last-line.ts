import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { makeLastLine } from "./sdk-task-history"

/** Complete conversational messages only; tool output and reasoning never become previews. */
export function messageLastLine(message: ClineMessage): HistoryItem["lastLine"] {
	if (message.partial) return undefined
	const text = message.text ?? ""
	if (message.type === "say") {
		if (["text", "completion_result", "plan_completion_result"].includes(message.say ?? "") && text.trim())
			return makeLastLine("agent", text)
		return undefined
	}
	if (message.ask === "completion_result" && text.trim()) return makeLastLine("agent", text)
	if (message.ask === "followup") {
		try {
			const question = JSON.parse(text).question
			if (typeof question === "string" && question.trim()) return makeLastLine("agent", question)
		} catch {
			/* Older asks carry plain text. */
		}
		return makeLastLine("agent", text || "answer a question")
	}
	if (message.ask === "command") return makeLastLine("ask", `approve command: ${text}`)
	if (message.ask === "tool") {
		try {
			const tool = JSON.parse(text)
			const path = typeof tool.path === "string" ? tool.path : "file"
			if (["editedExistingFile", "newFileCreated", "fileDeleted"].includes(tool.tool))
				return makeLastLine("ask", `approve edit to ${path}`)
			if (tool.tool === "readFile") return makeLastLine("ask", `approve reading ${path}`)
		} catch {
			/* Malformed or older tool asks use the generic description. */
		}
		return makeLastLine("ask", "approve tool use")
	}
	if (message.ask === "use_subagents") return makeLastLine("ask", "approve subagents")
	if (message.ask === "browser_action_launch") return makeLastLine("ask", "approve browser use")
	if (message.ask === "use_mcp_server") return makeLastLine("ask", "approve tool use")
	if (message.ask === "plan_mode_respond" || message.ask === "act_mode_respond") {
		try {
			return makeLastLine("agent", JSON.parse(text).response || text)
		} catch {
			return makeLastLine("agent", text)
		}
	}
	return undefined
}
