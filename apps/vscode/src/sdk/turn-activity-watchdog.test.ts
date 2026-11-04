import { afterEach, describe, expect, it, vi } from "vitest"
import { TurnActivityWatchdog } from "./turn-activity-watchdog"

afterEach(() => vi.useRealTimers())

const toolEvent = (type: "content_start" | "content_end", toolName: string, toolCallId = "call") =>
	({ type: "agent_event", payload: { sessionId: "s", event: { type, contentType: "tool", toolName, toolCallId } } }) as never

describe("TurnActivityWatchdog", () => {
	it.each(["spawn_agent", "wait_for_agents"])("doesn't fail a parent waiting in %s, however long the child takes", (tool) => {
		vi.useFakeTimers()
		const fail = vi.fn()
		const watchdog = new TurnActivityWatchdog(() => false, fail)
		watchdog.activity()
		watchdog.observe(toolEvent("content_start", tool))
		vi.advanceTimersByTime(3_600_000)
		expect(fail).not.toHaveBeenCalled()
		watchdog.observe(toolEvent("content_end", tool))
		vi.advanceTimersByTime(120_000)
		expect(fail).toHaveBeenCalledOnce()
	})

	it("still fails on a silent parent in any other tool", () => {
		vi.useFakeTimers()
		const fail = vi.fn()
		const watchdog = new TurnActivityWatchdog(() => false, fail)
		watchdog.activity()
		watchdog.observe(toolEvent("content_start", "read_files"))
		vi.advanceTimersByTime(120_000)
		expect(fail).toHaveBeenCalledOnce()
	})

	it("waits until every parallel wait has finished", () => {
		vi.useFakeTimers()
		const fail = vi.fn()
		const watchdog = new TurnActivityWatchdog(() => false, fail)
		watchdog.activity()
		watchdog.observe(toolEvent("content_start", "spawn_agent", "a"))
		watchdog.observe(toolEvent("content_start", "spawn_agent", "b"))
		watchdog.observe(toolEvent("content_end", "spawn_agent", "a"))
		vi.advanceTimersByTime(600_000)
		expect(fail).not.toHaveBeenCalled()
		watchdog.observe(toolEvent("content_end", "spawn_agent", "b"))
		vi.advanceTimersByTime(120_000)
		expect(fail).toHaveBeenCalledOnce()
	})

	it("a wait from a turn that ended doesn't shield the next one", () => {
		vi.useFakeTimers()
		const fail = vi.fn()
		const watchdog = new TurnActivityWatchdog(() => false, fail)
		watchdog.activity()
		watchdog.observe(toolEvent("content_start", "spawn_agent"))
		watchdog.stop()
		watchdog.activity()
		vi.advanceTimersByTime(120_000)
		expect(fail).toHaveBeenCalledOnce()
	})

	it("fails a silent turn after two minutes and resets on runtime activity", () => {
		vi.useFakeTimers()
		const fail = vi.fn()
		const watchdog = new TurnActivityWatchdog(() => false, fail)
		watchdog.activity()
		vi.advanceTimersByTime(119_999)
		expect(fail).not.toHaveBeenCalled()
		watchdog.activity()
		vi.advanceTimersByTime(119_999)
		expect(fail).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(fail).toHaveBeenCalledOnce()
		vi.advanceTimersByTime(120_000)
		expect(fail).toHaveBeenCalledOnce()
	})

	it("waits for pending decisions including preview preparation, then bounds silent time", () => {
		vi.useFakeTimers()
		let pending = true
		const fail = vi.fn()
		const watchdog = new TurnActivityWatchdog(() => pending, fail)
		watchdog.activity()
		vi.advanceTimersByTime(600_000)
		expect(fail).not.toHaveBeenCalled()
		pending = false
		watchdog.activity()
		vi.advanceTimersByTime(120_000)
		expect(fail).toHaveBeenCalledOnce()
	})

	it("disarms when the turn ends or the controller is disposed", () => {
		vi.useFakeTimers()
		const fail = vi.fn()
		const watchdog = new TurnActivityWatchdog(() => false, fail)
		watchdog.activity()
		watchdog.stop()
		vi.advanceTimersByTime(120_000)
		expect(fail).not.toHaveBeenCalled()
	})
})
