import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { NotebookToolRow, parseNotebookTool } from "./NotebookToolRow"

describe("parseNotebookTool", () => {
	it("ignores other tools and non-objects", () => {
		expect(parseNotebookTool({ tool: "readFile", path: "a.ts" })).toBeNull()
		expect(parseNotebookTool(null)).toBeNull()
	})

	it("reads action and name from the tool input, falling back to path", () => {
		expect(parseNotebookTool({ tool: "notebook", action: "read", name: "Dev plan" })).toEqual({
			action: "read",
			names: ["Dev plan"],
		})
		expect(parseNotebookTool({ tool: "notebook", action: "write", path: "decisions" })).toEqual({
			action: "write",
			names: ["decisions"],
		})
		expect(parseNotebookTool({ tool: "notebook", names: ["A", "B", 3] })).toEqual({ action: "read", names: ["A", "B"] })
	})
})

describe("NotebookToolRow", () => {
	it("shows read notes as chips", () => {
		render(<NotebookToolRow info={{ action: "read", names: ["Dev plan", "Codebase map"] }} />)
		const row = screen.getByTestId("notebook-tool-row")
		expect(row).toHaveTextContent("Read notebook")
		expect(screen.getByText("Dev plan")).toBeInTheDocument()
		expect(screen.getByText("Codebase map")).toBeInTheDocument()
	})

	it("shows written notes as chips, reviewed at the end", () => {
		const { rerender } = render(<NotebookToolRow info={{ action: "write", names: ["Decisions"] }} />)
		expect(screen.getByTestId("notebook-tool-row")).toHaveTextContent("Wrote")
		expect(screen.getByText("Decisions")).toBeInTheDocument()
		rerender(<NotebookToolRow info={{ action: "delete", names: ["A"] }} />)
		expect(screen.getByTestId("notebook-tool-row")).toHaveTextContent("Wants to delete")
		rerender(<NotebookToolRow info={{ action: "write", names: ["Tools"], aboutYou: true }} />)
		expect(screen.getByText("About you › Tools")).toBeInTheDocument()
	})
})
