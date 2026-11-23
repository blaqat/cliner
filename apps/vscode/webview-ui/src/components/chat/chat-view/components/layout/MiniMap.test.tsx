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
// apart and shifted by `scrollTop`, in a 400px viewport. As in ChatView, the task prompt is the
// first rendered row but not part of `messages`.
function setup(messages: ClineMessage[], turnActive: boolean) {
	const rows = [task, ...messages]
	const container = document.createElement("div")
	const scroller = document.createElement("div")
	scroller.dataset.virtuosoScroller = "true"
	scroller.scrollBy = vi.fn() as never
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
	const onJump = vi.fn()
	const props = { listKey: 1, onJump, scrollContainerRef, autoScrollDisabledRef, task }
	const view = render(<MiniMap {...props} messages={messages} rows={rows} turnActive={turnActive} />)
	const rerender = (next: ClineMessage[], active: boolean) => {
		renderRows(next.length + 1)
		view.rerender(<MiniMap {...props} messages={next} rows={[task, ...next]} turnActive={active} />)
	}
	const scrollTo = async (scrollTop: number) => {
		layout.scrollTop = scrollTop
		fireEvent.scroll(scroller)
		await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
	}
	return { autoScrollDisabledRef, onJump, rerender, scrollTo, scroller }
}

const strips = () => screen.getAllByTestId("chat-minimap-strip")
const inView = () => strips().map((strip) => strip.dataset.inView === "true")
const rail = () => screen.getByTestId("chat-minimap-rail")
// Turn rows: [0] task, [1] reply, [2] "go", [3] reply, [4] "again", [5] streaming reply.
const THREE_TURNS = [
	say(2, "text", "Earlier reply"),
	say(3, "user_feedback", "go"),
	say(4, "text", "Second reply"),
	say(5, "user_feedback", "again"),
	say(6, "text", "Work", true),
]

describe("MiniMap", () => {
	beforeEach(() => {
		document.body.replaceChildren()
	})

	it("needs two turns", () => {
		setup([say(2, "text", "Only reply")], false)
		expect(screen.queryByTestId("chat-minimap")).toBeNull()
	})

	it("keeps the streaming turn in view while auto-follow scrolls and rows grow", async () => {
		let rows = [...THREE_TURNS]
		const { rerender, scrollTo } = setup(rows, true)
		const live = strips().at(-1)
		// Rows 2-5 on screen (row 1 is under the sticky header); the last turn is current.
		await scrollTo(250)
		expect(inView()).toEqual([false, true, true])
		expect(live?.dataset.current).toBe("true")

		for (let ts = 7; ts < 14; ts++) {
			rows = [...rows, say(ts, ts % 2 ? "tool" : "text", "{}", ts % 3 === 0)]
			rerender(rows, true)
			await scrollTo(ts % 2 ? 250 : 350)
			// Same element (not remounted), still in view, still animating.
			expect(strips().at(-1)).toBe(live)
			expect(live?.dataset.inView).toBe("true")
			expect(live?.dataset.current).toBe("true")
			expect(live?.className).toContain("animate-minimap-live")
		}

		rerender(rows, false)
		expect(live?.className).not.toContain("animate-minimap-live")
	})

	it("highlights the turns on screen once the user scrolls away from the live end", async () => {
		const { autoScrollDisabledRef, scrollTo } = setup(THREE_TURNS, true)
		autoScrollDisabledRef.current = true
		// Rows 0-3 visible: the first two turns.
		await scrollTo(0)
		expect(inView()).toEqual([true, true, false])
		expect(strips()[0].dataset.current).toBe("true")
		// Rows 3-5 (row 2 sits under the sticky header).
		await scrollTo(280)
		expect(inView()).toEqual([false, true, true])
		expect(strips()[1].dataset.current).toBe("true")

		autoScrollDisabledRef.current = false
		await scrollTo(0)
		expect(inView().at(-1)).toBe(true)
	})

	it("previews the turn under the pointer and jumps to its prompt on click", () => {
		const { onJump } = setup(THREE_TURNS, false)
		rail().getBoundingClientRect = () => ({ top: 100, height: 20 }) as DOMRect
		fireEvent.mouseMove(rail(), { clientY: 110 })
		const preview = screen.getByTestId("chat-minimap-preview")
		expect(preview).toHaveTextContent("go")
		expect(preview).toHaveTextContent("Second reply")
		// The fisheye: the hovered strip is full width, its neighbors shrink.
		expect(strips()[1].className).toContain("scale-x-100")
		expect(strips()[0].className).toContain("scale-x-[0.667]")

		fireEvent.click(rail(), { clientY: 120 })
		expect(onJump).toHaveBeenCalledWith(4)
		fireEvent.mouseLeave(rail())
		expect(screen.queryByTestId("chat-minimap-preview")).toBeNull()
	})

	it("moves through turns from the keyboard and steps with the chevrons", async () => {
		const { autoScrollDisabledRef, onJump, scrollTo } = setup(THREE_TURNS, false)
		act(() => rail().focus())
		expect(screen.getByTestId("chat-minimap-preview")).toHaveTextContent("again")
		fireEvent.keyDown(rail(), { key: "Home" })
		expect(screen.getByTestId("chat-minimap-preview")).toHaveTextContent("Fix the bug")
		fireEvent.keyDown(rail(), { key: "ArrowDown" })
		fireEvent.keyDown(rail(), { key: "Enter" })
		expect(onJump).toHaveBeenLastCalledWith(2)

		autoScrollDisabledRef.current = true
		await scrollTo(0)
		expect(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "Next turn" }))
		expect(onJump).toHaveBeenLastCalledWith(2)
	})

	it("scrolls the chat with the wheel over the rail", () => {
		const { scroller } = setup(THREE_TURNS, false)
		fireEvent.wheel(screen.getByTestId("chat-minimap"), { deltaY: 120 })
		expect(scroller.scrollBy).toHaveBeenCalledWith({ top: 120 })
	})

	it("colors a turn waiting for approval", () => {
		setup(
			[say(2, "text", "Done"), say(3, "user_feedback", "run it"), { ts: 4, type: "ask", ask: "command", text: "make" }],
			false,
		)
		expect(strips().at(-1)?.dataset.attention).toBe("approval")
		expect(strips().at(-1)?.className).toContain("bg-warning")
	})
})
