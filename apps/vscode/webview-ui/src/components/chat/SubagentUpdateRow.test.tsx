import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SubagentUpdateRow } from "./SubagentUpdateRow"

describe("SubagentUpdateRow", () => {
	it("labels completion and interim messages separately and preserves their text", () => {
		render(
			<SubagentUpdateRow
				text={
					'<subagent_update agent="a1" status="done">result</subagent_update>\n<subagent_update agent="a2" status="message">still working</subagent_update>'
				}
			/>,
		)
		expect(screen.getByText("Subagent a1 finished")).toBeTruthy()
		expect(screen.getByText("Subagent a2 says…")).toBeTruthy()
		expect(screen.getByText("result").closest("details")?.open).toBe(false)
		expect(screen.getByText("still working")).toBeTruthy()
	})
})

it("renders side context as an expandable aside row, preserving literal text", () => {
	render(
		<SubagentUpdateRow
			text={'<side_thread_update thread="side-1">\nUse &lt;tag&gt; and &amp;lt;literal&amp;gt;\n</side_thread_update>'}
		/>,
	)
	expect(screen.getByText("Aside side-1 says…").closest("details")).not.toHaveAttribute("open")
	expect(screen.getByText("Use <tag> and &lt;literal&gt;")).toBeInTheDocument()
})
