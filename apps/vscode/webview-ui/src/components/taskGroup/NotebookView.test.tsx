import { GetTaskGroupResponse } from "@shared/proto/cline/task_group"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotebookView, noteSlugFromPath } from "./NotebookView"
import { requestNewNoteForm } from "./useTaskGroup"

const mocks = vi.hoisted(() => ({
	getTaskGroup: vi.fn(),
	createNote: vi.fn(),
	openNote: vi.fn(),
	state: {} as Record<string, unknown>,
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		getTaskGroup: (request: unknown) => mocks.getTaskGroup(request),
		createNote: (request: unknown) => mocks.createNote(request),
		openNote: (request: unknown) => mocks.openNote(request),
	},
}))

const NOW = 10 * 86_400_000
const HOUR = 3_600_000

const FIXTURE = GetTaskGroupResponse.fromPartial({
	group: { id: "g1", title: "Bulk invoice export", tags: [], noteCount: 3 },
	notes: [
		{
			slug: "ticket-brief",
			name: "Ticket brief",
			description: "Problem, scope and 7 ACs",
			size: 1229,
			updatedAt: NOW - 48 * HOUR,
			updatedBy: { kind: "thread", threadId: "t1", threadTitle: "Refine ticket" },
			readers: 4,
		},
		{
			slug: "decisions",
			name: "Decisions",
			description: "CSV only for v1, 10k row cap, async",
			size: 400,
			updatedAt: NOW - 3 * HOUR,
			updatedBy: { kind: "user" },
			readers: 2,
		},
		{
			slug: "review-checklist",
			name: "Review checklist",
			description: "What I check before opening the PR",
			size: 300,
			updatedAt: NOW - HOUR,
			updatedBy: { kind: "user" },
			readers: 0,
		},
	],
})

const renderView = async () => {
	render(<NotebookView now={NOW} taskGroupId="g1" />)
	await waitFor(() => expect(screen.getAllByTestId("notebook-note-row")).toHaveLength(3))
}

describe("NotebookView", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.getTaskGroup.mockReset().mockResolvedValue(FIXTURE)
		mocks.createNote.mockReset().mockResolvedValue({ path: "/home/u/.cline/data/task-groups/g1/notebook/open-questions.md" })
		mocks.openNote.mockReset().mockResolvedValue({})
		mocks.state = { taskGroups: [], hideTaskGroupView: vi.fn(), navigateToTaskGroup: vi.fn() }
	})

	it("lists notes newest first with size, last writer, age and readers", async () => {
		await renderView()
		const rows = screen.getAllByTestId("notebook-note-row")
		expect(rows[0]).toHaveTextContent("Review checklist")
		expect(rows[0]).toHaveTextContent("300 B · by you · 1h")
		expect(rows[0]).not.toHaveTextContent("read by")
		expect(rows[1]).toHaveTextContent("400 B · by you · 3h · read by 2")
		expect(rows[2]).toHaveTextContent("Problem, scope and 7 ACs")
		expect(rows[2]).toHaveTextContent("1.2 KB · Refine ticket · 2d · read by 4")
	})

	it("has a ⌂ / Task / Notebook breadcrumb whose task crumb returns to the task page", async () => {
		await renderView()
		expect(screen.getByTestId("task-group-header")).toHaveTextContent("Bulk invoice export")
		expect(screen.getByTestId("task-group-header")).toHaveTextContent("Notebook")
		fireEvent.click(screen.getByTestId("crumb-task"))
		expect(mocks.state.navigateToTaskGroup).toHaveBeenCalledWith("g1", "home")
	})

	it("filters by name and description", async () => {
		await renderView()
		fireEvent.change(screen.getByLabelText("Filter notes"), { target: { value: "csv" } })
		expect(screen.getAllByTestId("notebook-note-row")).toHaveLength(1)
		expect(screen.getByTestId("notebook-note-row")).toHaveTextContent("Decisions")
		fireEvent.change(screen.getByLabelText("Filter notes"), { target: { value: "zzz" } })
		expect(screen.getByText("No notes match.")).toBeInTheDocument()
	})

	it("opens a note's file on click", async () => {
		await renderView()
		fireEvent.click(screen.getAllByTestId("notebook-note-row")[2])
		expect(mocks.openNote).toHaveBeenCalledWith(expect.objectContaining({ taskGroupId: "g1", slug: "ticket-brief" }))
	})

	it("＋ New note creates the note inline, then opens it", async () => {
		await renderView()
		expect(screen.queryByTestId("notebook-new-note-form")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "＋ New note" }))
		const create = screen.getByRole("button", { name: "Create & open" })
		expect(create).toBeDisabled()
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Open questions" } })
		fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "Waiting on PM" } })
		fireEvent.click(create)
		await waitFor(() =>
			expect(mocks.createNote).toHaveBeenCalledWith(
				expect.objectContaining({ taskGroupId: "g1", name: "Open questions", description: "Waiting on PM" }),
			),
		)
		await waitFor(() =>
			expect(mocks.openNote).toHaveBeenCalledWith(expect.objectContaining({ taskGroupId: "g1", slug: "open-questions" })),
		)
		expect(screen.queryByTestId("notebook-new-note-form")).toBeNull()
		// The list refreshes with the new note.
		expect(mocks.getTaskGroup).toHaveBeenCalledTimes(2)
	})

	it("Cancel closes the form without creating anything", async () => {
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "＋ New note" }))
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(screen.queryByTestId("notebook-new-note-form")).toBeNull()
		expect(mocks.createNote).not.toHaveBeenCalled()
	})

	it("opens with the form shown when the task page's ＋ New asked for it", async () => {
		requestNewNoteForm()
		await renderView()
		expect(screen.getByTestId("notebook-new-note-form")).toBeInTheDocument()
	})

	it("keeps the form open with an error when creating fails", async () => {
		mocks.createNote.mockRejectedValue(new Error("boom"))
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "＋ New note" }))
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "X" } })
		fireEvent.click(screen.getByRole("button", { name: "Create & open" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't create the note")
		expect(mocks.openNote).not.toHaveBeenCalled()
	})
})

describe("noteSlugFromPath", () => {
	it("takes the file name without .md on any platform", () => {
		expect(noteSlugFromPath("/a/notebook/dev-plan.md")).toBe("dev-plan")
		expect(noteSlugFromPath("C:\\a\\notebook\\dev-plan-2.md")).toBe("dev-plan-2")
	})
})
