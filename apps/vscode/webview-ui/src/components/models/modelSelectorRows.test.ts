import { describe, expect, it } from "vitest"
import { modelSettingsFixture } from "./modelSelector.fixture"
import { describePick, samePick, selectorDataFromModelSettings } from "./modelSelectorRows"

describe("selectorDataFromModelSettings", () => {
	const { rows, ladder } = selectorDataFromModelSettings(modelSettingsFixture())
	const row = (id: string) => rows.find((candidate) => candidate.id === id)

	it("lists every chat and unknown model under its connection, hiding only non-chat rows", () => {
		expect(rows.map((candidate) => candidate.id)).toEqual(["sol", "g54", "tuned", "qwen", "broken", "sol-local"])
		expect(row("sol")?.group).toBe("Company gateway")
		expect(row("qwen")?.group).toBe("Local vLLM")
	})

	it("adds the connection to a shared name, and the upstream and short id if that's not enough", () => {
		expect(row("sol")?.label).toBe("GPT-6 Sol · Company gateway")
		expect(row("sol-local")?.label).toBe("GPT-6 Sol · Local vLLM")
		expect(row("g54")?.label).toBe("GPT-5.4")
		// The list shows these under their connection's heading, which already says it.
		expect(row("sol")?.groupedLabel).toBe("GPT-6 Sol")
		const state = modelSettingsFixture()
		state.settings.connections[1].name = "Company gateway"
		const same = selectorDataFromModelSettings(state).rows
		expect(same.find((candidate) => candidate.id === "sol")?.label).toBe("GPT-6 Sol · Company gateway · gpt-6-sol · sol")
	})

	it("offers a model only its levels, against a column that shows the rest", () => {
		expect(ladder.map((level) => level.label)).toEqual(["Default", "Low", "Medium", "High", "XHigh"])
		expect(row("g54")?.levels?.map((level) => level.id)).toEqual(["default", "high", "xhigh"])
	})

	it("gives no level control without known reasoning, with the reason", () => {
		expect(row("qwen")?.levels).toBeNull()
		expect(row("qwen")?.noLevelsReason).toBe("This model has no reasoning control")
		expect(row("qwen")?.noLevelsNote).toBeUndefined()
		expect(row("qwen")?.noLevelId).toBe("default")
		expect(row("tuned")?.levels).toBeNull()
		expect(row("tuned")?.noLevelsNote).toBe("Reasoning is unknown for acme-tuned-coder, so no level is sent.")
	})

	it("carries the host's reason a model can't run", () => {
		expect(row("broken")?.disabledReason).toBe("Connection credentials are missing.")
		expect(row("sol")?.disabledReason).toBeUndefined()
	})

	it("tidies imported level tokens and adds levels outside the standard ones", () => {
		const state = modelSettingsFixture()
		state.effective.g54.levels.value = [
			{ id: "default", label: "Default", rank: 0, request: { kind: "default" } },
			{ id: "xhigh", label: "xhigh", rank: 1, request: { kind: "effort", value: "xhigh" } },
			{ id: "max", label: "Max Budget", rank: 9, request: { kind: "thinking-budget", tokens: 64000 } },
		]
		const data = selectorDataFromModelSettings(state)
		expect(data.rows.find((candidate) => candidate.id === "g54")?.levels?.map((level) => level.label)).toEqual([
			"Default",
			"XHigh",
			"Max Budget",
		])
		expect(data.ladder.map((level) => level.id)).toEqual(["default", "low", "medium", "high", "xhigh", "max"])
	})
})

describe("describePick", () => {
	const { rows } = selectorDataFromModelSettings(modelSettingsFixture())

	it("shortens the level for a trigger", () => {
		expect(describePick(rows, { rowId: "g54", levelId: "high" })).toMatchObject({ model: "GPT-5.4", level: "High" })
		expect(describePick(rows, { rowId: "sol", levelId: "medium" }).level).toBe("Med")
	})

	it("flags a level the model doesn't offer", () => {
		expect(describePick(rows, { rowId: "g54", levelId: "medium" }).levelOffered).toBe(false)
	})

	it("says what's missing without a pick, or when the pick's model is gone", () => {
		expect(describePick(rows, null).model).toBe("Pick a model")
		expect(describePick(rows, { rowId: "gone", levelId: "low" }).model).toBe("Pick a model")
		expect(describePick([], null).model).toBe("No models yet")
	})
})

describe("samePick", () => {
	it("compares by value, and two empties match", () => {
		expect(samePick({ rowId: "a", levelId: "b" }, { rowId: "a", levelId: "b" })).toBe(true)
		expect(samePick({ rowId: "a", levelId: "b" }, { rowId: "a", levelId: "c" })).toBe(false)
		expect(samePick(null, null)).toBe(true)
	})
})
