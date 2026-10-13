import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import DetectedTicketChips from "./DetectedTicketChips"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))

describe("DetectedTicketChips", () => {
	beforeEach(() => {
		mocks.state = {}
	})

	it("shows dashed chips for ticket keys in the draft", () => {
		render(<DetectedTicketChips text="Look into PROJ-491: export times out" />)
		expect(screen.getByTestId("detected-ticket-chips")).toHaveTextContent("PROJ-491tag found in message")
		expect(screen.getByTestId("task-tag-chip").className).toContain("border-dashed")
	})

	it("renders nothing without tickets", () => {
		render(<DetectedTicketChips text="just a question" />)
		expect(screen.queryByTestId("detected-ticket-chips")).not.toBeInTheDocument()
	})

	it("skips tickets the thread already has or the user dismissed", () => {
		mocks.state = {
			currentTaskItem: { tags: [{ kind: "ticket", value: "PROJ-1", source: "auto" }], dismissedAutoTags: ["PROJ-2"] },
		}
		render(<DetectedTicketChips text="PROJ-1 PROJ-2 PROJ-3" />)
		expect(screen.getAllByTestId("task-tag-chip").map((chip) => chip.textContent)).toEqual(["PROJ-3"])
	})
})
