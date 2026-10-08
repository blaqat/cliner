import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import SubagentsSettingsSection from "./SubagentsSettingsSection"

const mocks = vi.hoisted(() => ({ update: vi.fn(), state: {} as Record<string, unknown> }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: mocks.update }))

describe("Subagents settings", () => {
	beforeEach(() => {
		mocks.update.mockClear()
		mocks.state = {}
	})
	it("defaults to enabled with unlimited concurrency and inherited permissions", () => {
		render(<SubagentsSettingsSection renderSectionHeader={() => null} />)
		for (const control of screen.getAllByRole("switch")) expect(control).toHaveAttribute("aria-checked", "true")
		expect(screen.getByRole("spinbutton")).toHaveValue(null)
	})
	it.each([
		["Enable subagents", "subagentsEnabled"],
		["Allow write subagents", "subagentsAllowWrite"],
		["Allow shell commands", "subagentsAllowCommands"],
		["Allow MCP tools", "subagentsAllowMcp"],
		["Allow web access", "subagentsAllowWeb"],
	])("persists %s through updateSettings", (label, key) => {
		render(<SubagentsSettingsSection renderSectionHeader={() => null} />)
		fireEvent.click(screen.getByRole("switch", { name: label }))
		expect(mocks.update).toHaveBeenCalledWith(key, false)
	})
	it("persists a limit and clears it to unlimited", () => {
		render(<SubagentsSettingsSection renderSectionHeader={() => null} />)
		const input = screen.getByRole("spinbutton")
		fireEvent.change(input, { target: { value: "3" } })
		fireEvent.blur(input)
		expect(mocks.update).toHaveBeenLastCalledWith("subagentsMaxConcurrent", 3)
		fireEvent.change(input, { target: { value: "" } })
		fireEvent.blur(input)
		expect(mocks.update).toHaveBeenLastCalledWith("subagentsMaxConcurrent", 0)
	})
	it("does not save an invalid limit", () => {
		render(<SubagentsSettingsSection renderSectionHeader={() => null} />)
		const input = screen.getByRole("spinbutton")
		fireEvent.change(input, { target: { value: "1.5" } })
		fireEvent.blur(input)
		expect(mocks.update).not.toHaveBeenCalled()
	})
	it("disables permission controls when subagents are off", () => {
		mocks.state = { subagentsEnabled: false }
		render(<SubagentsSettingsSection renderSectionHeader={() => null} />)
		expect(screen.getByRole("spinbutton")).toBeDisabled()
		expect(screen.getByRole("switch", { name: "Allow write subagents" })).toBeDisabled()
	})
})
