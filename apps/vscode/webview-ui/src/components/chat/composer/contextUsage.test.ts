import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
	CONTEXT_USAGE_COLORS,
	canCompactNow,
	contextUsageLevel,
	contextUsagePercent,
	formatChatCost,
	isCompactionRunning,
	showsCompactNudge,
} from "./contextUsage"

const compaction = (status: string, ts = 1): ClineMessage =>
	({ ts, type: "say", say: "compaction", text: JSON.stringify({ status, mode: "manual" }) }) as ClineMessage

describe("context usage helpers", () => {
	it("computes percent of the window, clamped, and undefined without a window", () => {
		expect(contextUsagePercent(50_000, 200_000)).toBe(25)
		expect(contextUsagePercent(300_000, 200_000)).toBe(100)
		expect(contextUsagePercent(undefined, 200_000)).toBe(0)
		expect(contextUsagePercent(1_000, undefined)).toBeUndefined()
		expect(contextUsagePercent(1_000, 0)).toBeUndefined()
	})

	it("turns yellow at 70% and red over 90%", () => {
		expect(contextUsageLevel(0)).toBe("ok")
		expect(contextUsageLevel(69.9)).toBe("ok")
		expect(contextUsageLevel(70)).toBe("warn")
		expect(contextUsageLevel(90)).toBe("warn")
		expect(contextUsageLevel(90.1)).toBe("high")
		expect(contextUsageLevel(100)).toBe("high")
	})

	it("maps levels to VS Code chart theme colors", () => {
		expect(CONTEXT_USAGE_COLORS).toEqual({
			ok: "var(--vscode-charts-green)",
			warn: "var(--vscode-charts-yellow)",
			high: "var(--vscode-charts-red)",
		})
	})

	it("formats cost and hides zero or unknown", () => {
		expect(formatChatCost(0.4213)).toBe("$0.42")
		expect(formatChatCost(12)).toBe("$12.00")
		expect(formatChatCost(0.004)).toBe("<$0.01")
		expect(formatChatCost(0)).toBeUndefined()
		expect(formatChatCost(undefined)).toBeUndefined()
		expect(formatChatCost(Number.NaN)).toBeUndefined()
	})

	it("detects a compaction still in progress from the latest divider", () => {
		expect(isCompactionRunning([])).toBe(false)
		expect(isCompactionRunning([compaction("started")])).toBe(true)
		expect(isCompactionRunning([compaction("started", 1), compaction("completed", 2)])).toBe(false)
		expect(isCompactionRunning([compaction("completed", 1), compaction("started", 2)])).toBe(true)
	})
})

describe("canCompactNow", () => {
	it("allows compaction between turns", () => {
		expect(canCompactNow({ turnPhase: "idle", sessionStatus: "done" })).toBe(true)
		expect(canCompactNow({ turnPhase: "completed" })).toBe(true)
	})

	it("refuses during a live question: awaiting_followup while the runtime still runs", () => {
		expect(canCompactNow({ turnPhase: "awaiting_followup", sessionStatus: "waiting" })).toBe(false)
		expect(canCompactNow({ turnPhase: "awaiting_followup", sessionStatus: "running" })).toBe(false)
	})

	it("allows it for a followup after the turn ended", () => {
		expect(canCompactNow({ turnPhase: "awaiting_followup", sessionStatus: "done" })).toBe(true)
	})

	it("refuses mid-turn, while an approval is pending, and when the host would refuse anyway", () => {
		expect(canCompactNow({ turnPhase: "streaming" })).toBe(false)
		expect(canCompactNow({ turnPhase: "awaiting_approval", sessionStatus: "waiting" })).toBe(false)
		expect(canCompactNow({ sessionStatus: "running" })).toBe(false)
		expect(canCompactNow({ legacyRunning: true })).toBe(false)
		expect(canCompactNow({ isSubagentView: true })).toBe(false)
		expect(canCompactNow({ errorRecoveryAvailable: true })).toBe(false)
		expect(canCompactNow({ compactionRunning: true })).toBe(false)
	})
})

describe("showsCompactNudge", () => {
	it("shows from 85% while compaction is possible", () => {
		expect(showsCompactNudge(true, 84.9)).toBe(false)
		expect(showsCompactNudge(true, 85)).toBe(true)
		expect(showsCompactNudge(false, 95)).toBe(false)
		expect(showsCompactNudge(true, undefined)).toBe(false)
	})
})
