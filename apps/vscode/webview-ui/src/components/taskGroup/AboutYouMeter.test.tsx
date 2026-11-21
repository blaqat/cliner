import { ABOUT_YOU_ID } from "@shared/task-groups"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { AboutYouContextLine } from "./AboutYouMeter"

const mocks = vi.hoisted(() => ({
	navigateToTaskGroup: vi.fn(),
	details: undefined as { notes: { slug: string; tokens?: number }[] } | undefined,
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ navigateToTaskGroup: mocks.navigateToTaskGroup }),
}))
vi.mock("./useTaskGroup", () => ({ useTaskGroup: () => ({ details: mocks.details, missing: false }) }))

beforeEach(() => {
	mocks.navigateToTaskGroup.mockReset()
	mocks.details = undefined
})

it("says what About you adds to every request and opens it", () => {
	mocks.details = {
		notes: [
			{ slug: "tools", tokens: 120 },
			{ slug: "style", tokens: 700 },
		],
	}
	const onOpen = vi.fn()
	render(<AboutYouContextLine onOpen={onOpen} />)
	const line = screen.getByTestId("about-you-context-line")
	expect(line).toHaveTextContent("About you · 2 notes, sent with every request")
	expect(line).toHaveTextContent("≈ 820 tokens")
	fireEvent.click(line)
	expect(onOpen).toHaveBeenCalled()
	expect(mocks.navigateToTaskGroup).toHaveBeenCalledWith(ABOUT_YOU_ID, "notebook")
})

it("says when About you is empty, and waits quietly while it loads", () => {
	const { rerender } = render(<AboutYouContextLine />)
	expect(screen.getByTestId("about-you-context-line")).toHaveTextContent("About you …")
	mocks.details = { notes: [] }
	rerender(<AboutYouContextLine />)
	expect(screen.getByTestId("about-you-context-line")).toHaveTextContent("About you · empty")
})
