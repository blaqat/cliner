import { describe, expect, it } from "bun:test"
import cases from "../../../evals/walkthrough/cases.json"
import { scoreWalkthrough } from "../../../evals/walkthrough/score"
import { fallback, repairOutput } from "./engine"

describe("walkthrough eval fixtures and judge", () => {
	it("provides fixed small, focused, medium and large cases without any model calls", () => {
		expect(cases.map((fixture) => fixture.id)).toEqual(["small", "focused", "medium", "large"])
		for (const fixture of cases) {
			const walk = fallback(
				fixture.id,
				"git",
				[],
				fixture.files.map((file) => ({
					...file,
					filePath: `/fixture/${file.path}`,
					beforeExists: true,
					afterExists: true,
				})),
			)
			expect(walk.hunks.length).toBeGreaterThan(0)
			expect(scoreWalkthrough(walk).problems).not.toContain("missing coverage")
		}
	})
	it("scores a complete concise review and penalizes unknown, duplicate and omitted anchors", () => {
		const fixture = cases[0]
		const live = fallback(
			"fixture",
			"git",
			[],
			fixture.files.map((file) => ({ ...file, filePath: `/fixture/${file.path}`, beforeExists: true, afterExists: true })),
		)
		const walk = repairOutput(
			{
				title: "Cancel slow requests",
				focus: "Extend the timeout and cancel on close.",
				chapters: [
					{
						title: "Requests",
						stops: [
							{
								title: "Cancel slow requests",
								prose: "The timeout increases to 90 seconds. Closing cancels the request.",
								hunkIds: ["h1"],
							},
						],
					},
				],
			},
			live,
		)
		expect(scoreWalkthrough(walk, fixture.concepts).score).toBe(100)
		walk.chapters[0].stops[0].hunkIds = ["unknown", "unknown"]
		const score = scoreWalkthrough(walk, fixture.concepts)
		expect(score.score).toBeLessThan(100)
		expect(score.problems).toEqual(expect.arrayContaining(["unknown aliases", "duplicate aliases", "missing coverage"]))
	})
})
