import type { ClineMessage } from "@shared/ExtensionMessage"
import type { NotebookChangesPayload } from "@shared/task-groups"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotebookChangesRow, parseNotebookChangesPayload } from "./NotebookChangesRow"

const mocks = vi.hoisted(() => ({
	state: { clineMessages: [] as ClineMessage[] },
	apply: vi.fn(),
	discard: vi.fn(),
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: { applyNotebookChanges: mocks.apply, discardNotebookChanges: mocks.discard },
}))

const payload: NotebookChangesPayload = {
	taskGroupId: "g1",
	threadId: "t1",
	status: "pending",
	changes: [
		{
			op: "create",
			slug: "ticket-brief",
			name: "Ticket brief",
			description: "Problem, scope and 7 ACs",
			content: "## Problem",
		},
		{ op: "update", slug: "decisions", name: "Decisions", description: "CSV only for v1", content: "- CSV only" },
		{ op: "delete", slug: "old-notes", name: "Old notes", description: "Stale" },
	],
}

const notebookMessage = (ts: number, p: unknown = payload): ClineMessage => ({
	ts,
	type: "say",
	say: "notebook_changes",
	text: typeof p === "string" ? p : JSON.stringify(p),
})

describe("NotebookChangesRow", () => {
	beforeEach(() => {
		mocks.apply.mockReset().mockResolvedValue({})
		mocks.discard.mockReset().mockResolvedValue({})
		mocks.state = { clineMessages: [notebookMessage(10)] }
	})

	it("renders a pending card with every change ticked", () => {
		render(<NotebookChangesRow message={notebookMessage(10)} />)
		expect(screen.getByText("Notebook changes · 3")).toBeInTheDocument()
		expect(screen.getAllByRole("checkbox")).toHaveLength(3)
		for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked()
		expect(screen.getByText("new")).toBeInTheDocument()
		expect(screen.getByText("edit")).toBeInTheDocument()
		expect(screen.getByText("delete")).toBeInTheDocument()
		expect(screen.getByText("Problem, scope and 7 ACs")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Apply 3" })).toBeEnabled()
		// Deletes have nothing to edit.
		expect(screen.queryByRole("button", { name: "Edit Old notes" })).not.toBeInTheDocument()
	})

	it("unticking a change lowers the Apply count", () => {
		render(<NotebookChangesRow message={notebookMessage(10)} />)
		fireEvent.click(screen.getByLabelText("Decisions"))
		expect(screen.getByRole("button", { name: "Apply 2" })).toBeInTheDocument()
		fireEvent.click(screen.getByLabelText("Ticket brief"))
		fireEvent.click(screen.getByLabelText("Old notes"))
		expect(screen.getByRole("button", { name: "Apply 0" })).toBeDisabled()
	})

	it("Edit opens a monospace textarea prefilled with the content and Done closes it", () => {
		render(<NotebookChangesRow message={notebookMessage(10)} />)
		fireEvent.click(screen.getByRole("button", { name: "Edit Decisions" }))
		const textarea = screen.getByRole("textbox", { name: "Content of Decisions" })
		expect(textarea).toHaveValue("- CSV only")
		expect(textarea).toHaveClass("font-mono")
		fireEvent.click(screen.getByRole("button", { name: "Done editing Decisions" }))
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.getByText("CSV only for v1")).toBeInTheDocument()
	})

	it("Apply sends include flags and only changed content, then shows the summary", async () => {
		const onOpenTaskGroup = vi.fn()
		render(<NotebookChangesRow message={notebookMessage(10)} onOpenTaskGroup={onOpenTaskGroup} />)
		fireEvent.click(screen.getByLabelText("Old notes"))
		fireEvent.click(screen.getByRole("button", { name: "Edit Decisions" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Content of Decisions" }), {
			target: { value: "- CSV only\n- 10k row cap" },
		})
		// Opening an editor without changing it must not send editedContent.
		fireEvent.click(screen.getByRole("button", { name: "Edit Ticket brief" }))
		fireEvent.click(screen.getByRole("button", { name: "Apply 2" }))
		await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1))
		expect(mocks.apply.mock.calls[0][0]).toMatchObject({
			threadId: "t1",
			items: [
				{ slug: "ticket-brief", include: true, editedContent: undefined },
				{ slug: "decisions", include: true, editedContent: "- CSV only\n- 10k row cap" },
				{ slug: "old-notes", include: false, editedContent: undefined },
			],
		})
		expect(await screen.findByText("Applied 2 notebook changes")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Open task" }))
		expect(onOpenTaskGroup).toHaveBeenCalledWith("g1")
	})

	it("keeps the card and shows an error when Apply fails", async () => {
		mocks.apply.mockRejectedValueOnce(new Error("offline"))
		render(<NotebookChangesRow message={notebookMessage(10)} />)
		fireEvent.click(screen.getByRole("button", { name: "Apply 3" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't apply")
		expect(screen.getByRole("button", { name: "Apply 3" })).toBeEnabled()
	})

	it("Discard all calls discardNotebookChanges for the thread", async () => {
		render(<NotebookChangesRow message={notebookMessage(10)} />)
		fireEvent.click(screen.getByRole("button", { name: "Discard all" }))
		await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t1" })))
		expect(await screen.findByText("Discarded notebook changes")).toBeInTheDocument()
		expect(mocks.apply).not.toHaveBeenCalled()
	})

	it("renders older pending cards as superseded", () => {
		mocks.state = { clineMessages: [notebookMessage(10), notebookMessage(20)] }
		render(<NotebookChangesRow message={notebookMessage(10)} />)
		expect(screen.getByTestId("notebook-changes-superseded")).toBeInTheDocument()
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
	})

	it("renders an applied summary with chips for the applied notes only", () => {
		render(
			<NotebookChangesRow
				message={notebookMessage(10, { ...payload, status: "applied", appliedSlugs: ["ticket-brief", "decisions"] })}
			/>,
		)
		const summary = screen.getByTestId("notebook-changes-summary")
		expect(summary).toHaveTextContent("Applied 2 notebook changes")
		expect(summary).toHaveTextContent("Ticket brief")
		expect(summary).toHaveTextContent("Decisions")
		expect(summary).not.toHaveTextContent("Old notes")
		expect(screen.getByRole("button", { name: "Open task" })).toBeInTheDocument()
	})

	it("renders a discarded summary, even when it is not the newest card", () => {
		mocks.state = { clineMessages: [notebookMessage(10), notebookMessage(20)] }
		render(<NotebookChangesRow message={notebookMessage(10, { ...payload, status: "discarded" })} />)
		expect(screen.getByTestId("notebook-changes-summary")).toHaveTextContent("Discarded notebook changes")
	})

	it("renders nothing for bad JSON or a malformed payload", () => {
		const { container, rerender } = render(<NotebookChangesRow message={notebookMessage(10, "{not json")} />)
		expect(container).toBeEmptyDOMElement()
		rerender(<NotebookChangesRow message={notebookMessage(10, { threadId: "t1", changes: [] })} />)
		expect(container).toBeEmptyDOMElement()
	})
})

describe("parseNotebookChangesPayload", () => {
	it("drops malformed changes and defaults unknown status to pending", () => {
		const parsed = parseNotebookChangesPayload(
			JSON.stringify({ ...payload, status: "weird", changes: [payload.changes[0], null, { op: "create" }] }),
		)
		expect(parsed?.status).toBe("pending")
		expect(parsed?.changes).toEqual([payload.changes[0]])
	})
})
