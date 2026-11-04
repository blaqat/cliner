import { describe, expect, it } from "vitest"
import { parseSettingsTarget, SETTINGS_TARGET_REDIRECTS, settingsModelElementId, settingsPageForTarget } from "./settingsTargets"

describe("shell targets", () => {
	it.each([
		["api-config", "models"],
		["profiles", "models"],
		["features", "agent"],
		["mcp-advanced", "tools"],
		["checkpoints", "agent"],
		["worktrees", "tools"],
		["terminal", "tools"],
		["general", "agent"],
		["reporting", "data"],
		["enter-sends-as", "layout"],
		["subagents", "subagents"],
		["about", "about"],
		["debug", "debug"],
		["remote-config", "about"],
	])("%s opens %s", (target, page) => {
		expect(settingsPageForTarget(target)).toBe(page)
	})

	it("every old target has a place to go", () => {
		for (const target of Object.keys(SETTINGS_TARGET_REDIRECTS)) {
			expect(settingsPageForTarget(target), target).toBeDefined()
		}
	})

	it("redirects name their row", () => {
		expect(parseSettingsTarget("checkpoints")).toEqual({ pageId: "agent", rowId: "agent.checkpoints" })
		expect(parseSettingsTarget("profiles")).toEqual({ pageId: "models", rowId: "models.background.generate" })
		expect(SETTINGS_TARGET_REDIRECTS["remote-config"]).toBe("about.remote-config")
	})

	it("page and row ids pass through", () => {
		expect(parseSettingsTarget("layout")).toEqual({ pageId: "layout" })
		expect(parseSettingsTarget("tools.terminal.reuse")).toEqual({ pageId: "tools", rowId: "tools.terminal.reuse" })
	})

	it("an invalid-pick link focuses the model's levels control", () => {
		const elementId = settingsModelElementId("row-1", "levels")
		expect(parseSettingsTarget("model:row-1:levels")).toEqual({
			pageId: "models",
			elementId,
			focusElementId: `${elementId}-control`,
		})
	})

	it("role and connection links open Models", () => {
		expect(parseSettingsTarget("role:chat")?.pageId).toBe("models")
		expect(parseSettingsTarget("connection:abc")?.pageId).toBe("models")
	})

	it("anything else is an element on the current page", () => {
		expect(parseSettingsTarget("some-element")).toEqual({ elementId: "some-element" })
		expect(parseSettingsTarget(undefined)).toBeUndefined()
	})
})
