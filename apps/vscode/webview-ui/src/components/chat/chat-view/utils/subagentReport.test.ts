import { describe, expect, it } from "vitest"
import { subagentReportText } from "./subagentReport"

describe("subagent report context", () => {
	it("preserves streamed and completed reader reports without quoting internal reasoning or tools", () => {
		const report = "# Report\n\n> Finding\n\n```ts\nconst a = 1\n```"
		expect(subagentReportText([{ ts: 1, type: "say", say: "text", text: "First finding", partial: true }])).toBe(
			"First finding",
		)
		expect(
			subagentReportText([
				{ ts: 1, type: "say", say: "task", text: "Review" },
				{ ts: 2, type: "say", say: "reasoning", text: "Internal reasoning" },
				{ ts: 3, type: "say", say: "tool", text: "tool input" },
				{ ts: 4, type: "say", say: "plan_completion_result", text: report },
				{ ts: 5, type: "ask", ask: "completion_result", text: "" },
			]),
		).toBe(report)
	})
})
