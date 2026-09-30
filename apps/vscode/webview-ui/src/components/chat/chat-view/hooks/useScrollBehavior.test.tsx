import { act, renderHook } from "@testing-library/react"
import type { MutableRefObject } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useScrollBehavior } from "./useScrollBehavior"

const commandMessage = {
	ts: 1,
	type: "ask",
	ask: "command",
	text: "echo hi",
}

describe("useScrollBehavior", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("scrolls to bottom after command output layout has been quiet for 500ms", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.handleLastRowContentChange()
		})

		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(499)
		})
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(scrollTo).toHaveBeenCalledWith({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "smooth",
		})
	})

	it("resets the 500ms wait when another command output change arrives", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.handleLastRowContentChange()
			scrollTo.mockClear()
			vi.advanceTimersByTime(400)
			result.current.handleLastRowContentChange()
			scrollTo.mockClear()
			vi.advanceTimersByTime(499)
		})
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(scrollTo).toHaveBeenCalledWith({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "smooth",
		})
	})

	it("does not re-pin command output changes after auto-scroll is disabled", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.disableAutoScrollRef.current = true
			result.current.handleLastRowContentChange()
			vi.runAllTimers()
		})

		expect(scrollTo).not.toHaveBeenCalled()
	})

	it("disables auto-scroll when a user expands a row", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [commandMessage as any], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(commandMessage.ts)
		})

		expect(result.current.disableAutoScrollRef.current).toBe(true)
	})

	it("keeps auto-scroll enabled when command output expands programmatically", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [commandMessage as any], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(commandMessage.ts, { preserveAutoScroll: true })
		})

		expect(result.current.disableAutoScrollRef.current).toBe(false)
	})

	describe("minimap jumps", () => {
		const rows = [commandMessage, { ...commandMessage, ts: 2 }] as any[]

		const setup = () => {
			const hook = renderHook(() => useScrollBehavior([], [], rows, {}, vi.fn()))
			const scrollTo = vi.fn()
			const scrollToIndex = vi.fn()
			;(hook.result.current.virtuosoRef as MutableRefObject<unknown>).current = { scrollTo, scrollToIndex }
			const container = document.createElement("div")
			const scroller = document.createElement("div")
			scroller.dataset.virtuosoScroller = "true"
			container.appendChild(scroller)
			;(hook.result.current.scrollContainerRef as MutableRefObject<HTMLDivElement>).current = container
			act(() => {
				vi.runOnlyPendingTimers()
			})
			scrollTo.mockClear()
			return { ...hook, scrollTo, scrollToIndex, scroller }
		}

		it("keeps follow off after jumping to the last row when the jump leaves the bottom", () => {
			const { result, scrollTo, scrollToIndex } = setup()
			act(() => {
				result.current.setIsAtBottom(true)
			})

			act(() => {
				result.current.scrollToIndex(rows.length - 1)
				// The jump aligns the tall streaming reply's start, which leaves the bottom.
				result.current.setIsAtBottom(false)
				vi.advanceTimersByTime(1_000)
			})
			expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: rows.length - 1, align: "start" }))
			expect(result.current.disableAutoScrollRef.current).toBe(true)

			// Streaming growth must not pull the reader back to the bottom.
			act(() => {
				result.current.handleLastRowContentChange()
				vi.runAllTimers()
			})
			expect(scrollTo).not.toHaveBeenCalled()
		})

		it("re-enables follow when the jump lands at the bottom", () => {
			const { result } = setup()
			act(() => {
				result.current.setIsAtBottom(true)
				result.current.scrollToIndex(rows.length - 1)
			})
			expect(result.current.disableAutoScrollRef.current).toBe(true)

			act(() => {
				vi.advanceTimersByTime(1_000)
			})
			expect(result.current.disableAutoScrollRef.current).toBe(false)
		})

		it("waits for the smooth scroll to settle before checking the bottom", () => {
			const { result, scroller } = setup()
			act(() => {
				result.current.scrollToIndex(0)
				vi.advanceTimersByTime(150)
				scroller.dispatchEvent(new Event("scroll"))
				result.current.setIsAtBottom(true)
				vi.advanceTimersByTime(150)
			})
			expect(result.current.disableAutoScrollRef.current).toBe(true)

			act(() => {
				vi.advanceTimersByTime(100)
			})
			expect(result.current.disableAutoScrollRef.current).toBe(false)
		})
	})
})
