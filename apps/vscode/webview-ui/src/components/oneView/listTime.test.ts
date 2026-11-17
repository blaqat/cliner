import { describe, expect, it } from "vitest"
import { formatFullDate, formatListTime, listTimeTitle } from "./listTime"

const NOW = new Date(2026, 9, 29, 12).getTime()
const DAY = 86400000
describe("list time", () => {
	it("keeps relative ages under five days", () => {
		expect([0, 5 * 60000, 3 * 3600000, 2 * DAY].map((age) => formatListTime(NOW - age, NOW))).toEqual([
			"now",
			"5m",
			"3h",
			"2d",
		])
	})
	it("switches to dates at five days, adding a year only for older years", () => {
		expect(formatListTime(NOW - 5 * DAY, NOW)).toBe("Oct 24")
		expect(formatListTime(new Date(2025, 9, 29).getTime(), NOW)).toBe("Oct 29, 2025")
	})
	it("puts full message and agent dates in the tooltip", () => {
		expect(listTimeTitle({ activityTs: NOW - DAY, agentActivityTs: NOW }, NOW)).toContain(formatFullDate(NOW - DAY))
		expect(listTimeTitle({ activityTs: NOW - DAY, agentActivityTs: NOW }, NOW)).toContain(formatFullDate(NOW))
	})
})
