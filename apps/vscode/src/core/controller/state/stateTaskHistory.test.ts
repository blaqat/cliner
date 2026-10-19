import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { buildStateTaskHistory, compactHistoryItem } from "./stateTaskHistory"

const item = (id: string, ts: number, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

/** Newest first, as the state builders pass it in. */
const sortedRoots = (count: number) => Array.from({ length: count }, (_, i) => item(`t${i}`, 10_000 - i))

describe("buildStateTaskHistory", () => {
	it("keeps every root thread past the old 100 cut so the inbox matches History", () => {
		const result = buildStateTaskHistory(sortedRoots(450))

		expect(result).toHaveLength(450)
		expect(result.map((entry) => entry.id)).toContain("t449")
	})

	it("compacts rows past the detail window and keeps the focused thread whole", () => {
		const long = "x".repeat(2_000)
		const history = Array.from({ length: 150 }, (_, i) =>
			item(`t${i}`, 10_000 - i, { task: long, apiSelection: { actProfileId: "p" } }),
		)

		const result = buildStateTaskHistory(history, ["t140"], 100)

		expect(result[0].apiSelection).toBeDefined()
		expect(result[0].task).toHaveLength(2_000)
		expect(result[120].apiSelection).toBeUndefined()
		expect(result[120].task.length).toBeLessThan(2_000)
		expect(result[140].apiSelection).toBeDefined()
		expect(result[140].task).toHaveLength(2_000)
	})

	it("carries subagents of every root, nested spawns included, and drops ones with no root", () => {
		const history = [
			item("root", 100),
			item("child", 99, { isSubagent: true, parentTaskId: "root" }),
			item("grandchild", 98, { isSubagent: true, parentTaskId: "child" }),
			item("orphanAgent", 97, { isSubagent: true, parentTaskId: "gone" }),
			item("aside", 96, { parentTaskId: "gone" }),
		]

		expect(buildStateTaskHistory(history).map((entry) => entry.id)).toEqual(["root", "aside", "child", "grandchild"])
	})

	it("compactHistoryItem leaves short rows alone", () => {
		const short = item("a", 1)

		expect(compactHistoryItem(short)).toEqual(short)
	})
})
