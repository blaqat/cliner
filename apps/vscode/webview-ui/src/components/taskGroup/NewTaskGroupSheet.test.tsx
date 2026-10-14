import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NewTaskGroupSheet, parseTagInput } from "./NewTaskGroupSheet"

const mocks = vi.hoisted(() => ({
	createTaskGroup: vi.fn(),
	setThreadTaskGroup: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		createTaskGroup: (request: unknown) => mocks.createTaskGroup(request),
		setThreadTaskGroup: (request: unknown) => mocks.setThreadTaskGroup(request),
	},
}))

function renderSheet(props: Partial<React.ComponentProps<typeof NewTaskGroupSheet>> = {}) {
	const onOpenChange = vi.fn()
	const onCreated = vi.fn()
	render(<NewTaskGroupSheet onCreated={onCreated} onOpenChange={onOpenChange} open origin="home" {...props} />)
	return { onOpenChange, onCreated, sheet: screen.getByTestId("new-task-sheet") }
}

describe("parseTagInput", () => {
	it("treats a lone ticket key or issue URL as a ticket, anything else as a label", () => {
		expect(parseTagInput(" PROJ-1 ")).toEqual({ kind: "ticket", value: "PROJ-1" })
		expect(parseTagInput("https://github.com/o/r/issues/7")).toEqual({ kind: "ticket", value: "o/r#7" })
		expect(parseTagInput("needs PROJ-1")).toEqual({ kind: "label", value: "needs PROJ-1" })
		expect(parseTagInput("backend")).toEqual({ kind: "label", value: "backend" })
		expect(parseTagInput("  ")).toBeUndefined()
	})

	it("reads branch:name and ⎇ name as branch tags", () => {
		expect(parseTagInput("branch:feature/foo")).toEqual({ kind: "branch", value: "feature/foo" })
		expect(parseTagInput(" Branch: PROJ-1-fix ")).toEqual({ kind: "branch", value: "PROJ-1-fix" })
		expect(parseTagInput("⎇ main")).toEqual({ kind: "branch", value: "main" })
		expect(parseTagInput("branch:")).toBeUndefined()
		expect(parseTagInput("branches")).toEqual({ kind: "label", value: "branches" })
	})
})

describe("NewTaskGroupSheet", () => {
	beforeEach(() => {
		mocks.createTaskGroup.mockReset().mockResolvedValue({ id: "g1" })
		mocks.setThreadTaskGroup.mockReset().mockResolvedValue({})
		mocks.state = { currentBranch: "feature/export" }
	})

	it("is a bottom sheet with the title focused and the home copy", () => {
		const { sheet } = renderSheet()
		expect(sheet.className).toContain("bottom-0")
		expect(sheet.className).not.toContain("top-[35%]")
		expect(within(sheet).getByLabelText("Title")).toHaveFocus()
		expect(sheet).toHaveTextContent("Creates an empty task. Start threads from its page or pick it with the task pill.")
	})

	it("closes on Escape", () => {
		const { onOpenChange } = renderSheet()
		fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Escape" })
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("closes on backdrop click", async () => {
		const { onOpenChange } = renderSheet()
		// Radix arms its outside-pointer listener on the next tick after opening.
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
		fireEvent.pointerDown(screen.getByTestId("sheet-backdrop"))
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("requires a title", () => {
		const { sheet } = renderSheet()
		const create = within(sheet).getByRole("button", { name: "Create task" })
		expect(create).toBeDisabled()
		fireEvent.change(within(sheet).getByLabelText("Title"), { target: { value: "  " } })
		expect(create).toBeDisabled()
		fireEvent.change(within(sheet).getByLabelText("Title"), { target: { value: "Export timeouts" } })
		expect(create).toBeEnabled()
	})

	it("suggests the current branch until it's added as a tag", () => {
		const { sheet } = renderSheet()
		fireEvent.click(within(sheet).getByRole("button", { name: "Add branch tag feature/export" }))
		expect(within(sheet).queryByText("Suggested")).not.toBeInTheDocument()
		expect(within(sheet).getByRole("button", { name: "Remove tag feature/export" })).toBeInTheDocument()
	})

	it("adds typed tags as chips (Enter or comma) and removes them with × or Backspace", () => {
		const { sheet } = renderSheet()
		const input = within(sheet).getByLabelText("Tags")
		fireEvent.change(input, { target: { value: "PROJ-9" } })
		fireEvent.keyDown(input, { key: "Enter" })
		fireEvent.change(input, { target: { value: "backend" } })
		fireEvent.keyDown(input, { key: "," })
		const chips = within(sheet)
			.getAllByTestId("task-tag-chip")
			.filter((chip) => chip.tagName === "SPAN")
		expect(chips.map((chip) => [chip.dataset.kind, chip.textContent?.replace("×", "")])).toEqual([
			["ticket", "PROJ-9"],
			["label", "backend"],
		])

		fireEvent.keyDown(input, { key: "Backspace" })
		expect(within(sheet).queryByText("backend")).not.toBeInTheDocument()
		fireEvent.click(within(sheet).getByRole("button", { name: "Remove tag PROJ-9" }))
		expect(within(sheet).queryByText("PROJ-9")).not.toBeInTheDocument()
	})

	it("creates the task with its tags, including an uncommitted tag draft", async () => {
		const { sheet, onCreated, onOpenChange } = renderSheet()
		fireEvent.change(within(sheet).getByLabelText("Title"), { target: { value: " Export timeouts " } })
		fireEvent.change(within(sheet).getByLabelText("Tags"), { target: { value: "PROJ-9" } })
		await act(async () => {
			fireEvent.submit(within(sheet).getByLabelText("Title"))
		})

		expect(mocks.createTaskGroup).toHaveBeenCalledWith({
			title: "Export timeouts",
			tags: [{ kind: "ticket", value: "PROJ-9", source: "user" }],
		})
		expect(mocks.setThreadTaskGroup).not.toHaveBeenCalled()
		expect(onCreated).toHaveBeenCalledWith("g1")
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("from an existing thread, moves that thread into the new task", async () => {
		const { sheet } = renderSheet({ origin: "thread", threadId: "t1" })
		expect(sheet).toHaveTextContent("This thread moves into the new task.")
		fireEvent.change(within(sheet).getByLabelText("Title"), { target: { value: "Export" } })
		await act(async () => {
			fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }))
		})
		expect(mocks.setThreadTaskGroup).toHaveBeenCalledWith({ threadId: "t1", taskGroupId: "g1" })
	})

	it("from the pill without a draft ticket, says the next message starts the thread", () => {
		const { sheet } = renderSheet({ origin: "composer" })
		expect(sheet).toHaveTextContent("Your message starts the first thread in this task.")
		expect(sheet).not.toHaveTextContent("came from your message")
	})

	it("shows an inline error and stays open when creating fails", async () => {
		mocks.createTaskGroup.mockRejectedValueOnce(new Error("disk full"))
		vi.spyOn(console, "error").mockImplementation(() => {})
		const { sheet, onOpenChange } = renderSheet()
		fireEvent.change(within(sheet).getByLabelText("Title"), { target: { value: "Export" } })
		await act(async () => {
			fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }))
		})
		expect(within(sheet).getByRole("alert")).toHaveTextContent("Couldn't create the task")
		expect(onOpenChange).not.toHaveBeenCalledWith(false)
	})
})
