import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ScriptHelper from "./ScriptHelper"
import { TEST_MODULE } from "./scriptFixtures"

function renderHelper(optionsText: string, onChange = vi.fn()) {
	render(<ScriptHelper onChange={onChange} optionsText={optionsText} script={TEST_MODULE} />)
	return onChange
}

describe("ScriptHelper", () => {
	it("lists every option with kind, required or optional, and description", () => {
		renderHelper("")
		const module = screen.getByTestId("script-option-module")
		expect(module).toHaveTextContent("module")
		expect(module).toHaveTextContent("required")
		expect(module).toHaveTextContent("choice")
		expect(module).toHaveTextContent("Module to test")
		const filter = screen.getByTestId("script-option-filter")
		expect(filter).toHaveTextContent("optional")
		expect(filter).toHaveTextContent("text")
		expect(screen.getByTestId("script-option-watch")).toHaveTextContent("flag")
		expect(screen.getByTestId("script-helper")).toHaveTextContent("Run one module's tests")
	})

	it("says what is needed and blocks with an inline hint, and shows no command preview", () => {
		renderHelper("watch")
		expect(screen.getByTestId("script-helper-status")).toHaveTextContent("Needs module")
		expect(screen.queryByText(/bun run|\$ /)).not.toBeInTheDocument()
	})

	it("is ready once required options are set", () => {
		renderHelper("module:api filter:slow")
		expect(screen.getByTestId("script-helper-status")).toHaveTextContent("Ready. Enter runs it.")
		expect(screen.getByTestId("script-option-module")).toHaveTextContent("✓ api")
	})

	it("reports a bad choice or unknown option", () => {
		renderHelper("module:api nope ")
		expect(screen.getByTestId("script-helper-status")).toHaveTextContent('Unknown option "nope"')
	})

	it("suggests Tab for an option name that is still being typed", () => {
		renderHelper("module:api wa")
		expect(screen.getByTestId("script-helper-status")).toHaveTextContent("Tab completes watch")
	})

	it("filters the choices of the option being typed", () => {
		renderHelper("module:s")
		const module = screen.getByTestId("script-option-module")
		expect(within(module).getByTestId("script-choice-module-shared")).toBeInTheDocument()
		expect(within(module).queryByTestId("script-choice-module-api")).not.toBeInTheDocument()
	})

	it("filters the option list by the bare word being typed", () => {
		renderHelper("module:api wa")
		expect(screen.getByTestId("script-option-watch")).toBeInTheDocument()
		expect(screen.queryByTestId("script-option-filter")).not.toBeInTheDocument()
		expect(screen.queryByTestId("script-option-module")).not.toBeInTheDocument()
	})

	it("picks a choice by clicking it, replacing what was typed", () => {
		const onChange = renderHelper("module:s")
		fireEvent.click(screen.getByTestId("script-choice-module-shared"))
		expect(onChange).toHaveBeenCalledWith("module:shared ")
	})

	it("adds a flag or opens a value from the helper", () => {
		const onChange = renderHelper("module:api ")
		fireEvent.click(within(screen.getByTestId("script-option-watch")).getByText("add flag"))
		expect(onChange).toHaveBeenLastCalledWith("module:api watch ")
		fireEvent.click(within(screen.getByTestId("script-option-filter")).getByText("type a value"))
		expect(onChange).toHaveBeenLastCalledWith("module:api filter:")
	})
})
