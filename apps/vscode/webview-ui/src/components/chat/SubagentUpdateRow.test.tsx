import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	value: {
		taskHistory: [] as unknown[],
		clineMessages: [] as unknown[],
		turnState: undefined as { phase: string } | undefined,
		currentTaskItem: { id: "main" },
	},
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state.value }))

import { SubagentUpdateRow } from "./SubagentUpdateRow"

describe("SubagentUpdateRow", () => {
	it("shows each subagent update as a row with its status and text", () => {
		state.value.taskHistory = [{ id: "c1", isSubagent: true, agentId: "a1", task: "Find every caller" }]
		render(
			<SubagentUpdateRow
				text={
					'<subagent_update agent="a1" status="done">result</subagent_update>\n<subagent_update agent="a2" status="message">still working</subagent_update>'
				}
			/>,
		)
		expect(screen.getAllByTestId("update-row")).toHaveLength(2)
		expect(screen.getByRole("button", { name: "Find every caller" })).toBeInTheDocument()
		expect(screen.getByText("Subagent finished")).toBeInTheDocument()
		expect(screen.getByText("Subagent says")).toBeInTheDocument()
		expect(screen.getByText("result")).toBeInTheDocument()
		expect(screen.getByText("still working")).toBeInTheDocument()
	})

	it("shows a side-thread note with its title and literal text, waiting while Main is idle", () => {
		state.value.taskHistory = [{ id: "side-1", parentTaskId: "main", task: "Is 500ms too short?", sideKind: "side" }]
		state.value.clineMessages = [{ ts: 5, type: "say", say: "subagent_update" }]
		render(
			<SubagentUpdateRow
				message={{ ts: 5, type: "say", say: "subagent_update" }}
				text={'<side_thread_update thread="side-1">\nUse &lt;tag&gt; and &amp;lt;literal&amp;gt;\n</side_thread_update>'}
			/>,
		)
		expect(screen.getByText("From side thread")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Is 500ms too short?" })).toBeInTheDocument()
		expect(screen.getByText("Use <tag> and &lt;literal&gt;")).toBeInTheDocument()
		expect(screen.getByText("Waits for your next message")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Send now" })).toBeInTheDocument()
	})

	it("says Main read the note once a turn started after it", () => {
		state.value.clineMessages = [
			{ ts: 5, type: "say", say: "subagent_update" },
			{ ts: 6, type: "say", say: "api_req_started" },
		]
		render(
			<SubagentUpdateRow
				message={{ ts: 5, type: "say", say: "subagent_update" }}
				text={'<side_thread_update thread="gone">\nnote\n</side_thread_update>'}
			/>,
		)
		expect(screen.getByText("Main read it at its next step")).toBeInTheDocument()
		expect(screen.getByText("a deleted side thread")).toBeInTheDocument()
	})
})
