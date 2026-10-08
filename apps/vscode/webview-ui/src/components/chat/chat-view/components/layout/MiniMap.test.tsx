import type { ClineMessage } from "@shared/ExtensionMessage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { createRef, type RefObject } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MiniMap } from "./MiniMap"

const say = (ts: number, sayType: ClineMessage["say"], text?: string, partial?: boolean): ClineMessage => ({
	ts,
	type: "say",
	say: sayType,
	text,
	partial,
})

const task = say(1, "task", "Fix the bug")
const ROW_HEIGHT = 100

// A stand-in for Virtuoso's scroller: one [data-index] element per row, laid out ROW_HEIGHT
// apart and shifted by `scrollTop`, so the minimap can measure the row at the viewport top.
function setup(rows: ClineMessage[], turnActive: boolean) {
	const container = document.createElement("div")
	const scroller = document.createElement("div")
	scroller.dataset.virtuosoScroller = "true"
	container.appendChild(scroller)
	document.body.appendChild(container)
	const layout = { scrollTop: 0 }
	scroller.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect
	const renderRows = (count: number) => {
		scroller.replaceChildren()
		for (let index = 0; index < count; index++) {
			const el = document.createElement("div")
			el.dataset.index = String(index)
			el.getBoundingClientRect = () => {
				const top = index * ROW_HEIGHT - layout.scrollTop
				return { top, bottom: top + ROW_HEIGHT } as DOMRect
			}
			scroller.appendChild(el)
		}
	}
	renderRows(rows.length)

	const scrollContainerRef = { current: container } as RefObject<HTMLDivElement>
	const autoScrollDisabledRef = createRef<boolean>() as { current: boolean }
	autoScrollDisabledRef.current = false
	const props = { listKey: 1, onJump: vi.fn(), scrollContainerRef, autoScrollDisabledRef, task }
	const view = render(<MiniMap {...props} messages={rows} rows={rows} turnActive={turnActive} />)
	const rerender = (next: ClineMessage[], active: boolean) => {
		renderRows(next.length)
		view.rerender(<MiniMap {...props} messages={next} rows={next} turnActive={active} />)
	}
	const scrollTo = async (scrollTop: number) => {
		layout.scrollTop = scrollTop
		fireEvent.scroll(scroller)
		await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
	}
	return { autoScrollDisabledRef, rerender, scrollTo }
}

const current = () => screen.getAllByRole("button").find((button) => button.getAttribute("aria-current") === "location")
const squares = () => screen.getAllByRole("button")

describe("MiniMap", () => {
	beforeEach(() => {
		document.body.replaceChildren()
	})

	it("keeps the streaming reply steadily current while auto-follow scrolls and rows grow", async () => {
		// Rows: [0] reply, [1] user, [2..] the streaming reply.
		let rows = [say(2, "text", "Earlier reply"), say(3, "user_feedback", "go"), say(4, "text", "Work", true)]
		const { rerender, scrollTo } = setup(rows, true)
		const live = squares().at(-1)
		expect(current()).toBe(live)

		// Pin-to-bottom scrolls leave the top row wobbling across the turn boundary.
		for (let ts = 5; ts < 12; ts++) {
			rows = [...rows, say(ts, ts % 2 ? "tool" : "text", "{}", ts % 3 === 0)]
			rerender(rows, true)
			await scrollTo(ts % 2 ? 50 : 150)
			// Same element (not remounted), still current, still animating.
			expect(squares().at(-1)).toBe(live)
			expect(current()).toBe(live)
			expect(live?.className).toContain("animate-minimap-live")
		}

		rerender(rows, false)
		expect(live?.className).not.toContain("animate-minimap-live")
		expect(current()).toBe(live)
	})

	it("follows the viewport once the user scrolls away from the live end", async () => {
		const rows = [say(2, "text", "Earlier reply"), say(3, "user_feedback", "go"), say(4, "text", "Work", true)]
		const { autoScrollDisabledRef, scrollTo } = setup(rows, true)
		const [, firstReply, user, live] = squares()

		autoScrollDisabledRef.current = true
		await scrollTo(0)
		expect(current()).toBe(firstReply)
		await scrollTo(100)
		expect(current()).toBe(user)
		await scrollTo(200)
		expect(current()).toBe(live)

		// Back at the live end: pinned again regardless of which row is on top.
		autoScrollDisabledRef.current = false
		await scrollTo(0)
		expect(current()).toBe(live)
	})

	it("colors each square like the block it jumps to, and marks the current one with an outline", () => {
		const rows: ClineMessage[] = [
			say(2, "completion_result", "Done"),
			say(3, "user_feedback", "why?"),
			{ ts: 4, type: "ask", ask: "plan_mode_respond", text: JSON.stringify({ response: "Because" }) },
		]
		setup(rows, false)
		expect(squares().map((square) => square.dataset.kind)).toEqual(["user", "completion", "user", "answer"])
		const [, completion, , answer] = squares()
		expect(completion.className).toContain("bg-minimap-completion")
		expect(answer.className).toContain("bg-minimap-answer")
		// The current square keeps its fill: the highlight is an outline.
		expect(current()).toBe(answer)
		expect(answer.className).toContain("outline-minimap-current")
	})
})
