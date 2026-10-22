import { afterEach, describe, expect, it, vi } from "vitest"
import { TurnActivityWatchdog } from "./turn-activity-watchdog"

afterEach(() => vi.useRealTimers())

describe("TurnActivityWatchdog", () => {
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
