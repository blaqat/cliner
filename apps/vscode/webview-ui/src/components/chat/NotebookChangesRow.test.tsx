import type { ClineMessage } from "@shared/ExtensionMessage"
import type { NotebookChangesPayload } from "@shared/task-groups"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotebookChangesRow, parseNotebookChangesPayload } from "./NotebookChangesRow"

const mocks = vi.hoisted(() => ({
	state: { clineMessages: [] as ClineMessage[] },
	apply: vi.fn(),
	discard: vi.fn(),
	action: vi.fn(),
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		applyNotebookChanges: mocks.apply,
		discardNotebookChanges: mocks.discard,
		notebookAction: mocks.action,
	},
}))
const payload: NotebookChangesPayload = {
	revision: "r1",
	taskGroupId: "g1",
	threadId: "t1",
	status: "pending",
	changes: [
		{
			op: "update",
			slug: "plan",
			name: "Plan",
			description: "",
			content: "new",
			diff: [
				{ kind: "collapsed", text: "one\ntwo\nthree" },
				{ kind: "remove", text: "old" },
				{ kind: "add", text: "new" },
			],
		},
	],
}
const message = (ts = 10, p: unknown = payload): ClineMessage => ({
	ts,
	type: "say",
	say: "notebook_changes",
	text: JSON.stringify(p),
})
beforeEach(() => {
	mocks.apply.mockReset().mockResolvedValue({})
	mocks.discard.mockReset().mockResolvedValue({})
	mocks.action.mockReset().mockResolvedValue({})
	mocks.state = { clineMessages: [message()] }
})
describe("NotebookChangesRow", () => {
	it("shows unified diff, expands context, and has no per-change selection", () => {
		render(<NotebookChangesRow message={message()} />)
		expect(screen.getByText("−old")).toBeInTheDocument()
		expect(screen.getByText("+new")).toBeInTheDocument()
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "⋯ 3 lines" }))
		expect(screen.getByText("one")).toBeInTheDocument()
	})
	it("Edit opens the host editor with the exact review revision", async () => {
		render(<NotebookChangesRow message={message()} />)
		fireEvent.click(screen.getByRole("button", { name: "Edit Plan" }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(
				expect.objectContaining({ action: "edit", threadId: "t1", taskGroupId: "g1", slug: "plan", revision: "r1" }),
			),
		)
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})
	it("shows a rejected-save draft with Retry / Reload that target the card revision", async () => {
		const withDraft = {
			...payload,
			changes: [{ ...payload.changes[0], draft: { ts: 5, reason: "Notebook changes have changed since this review." } }],
		}
		mocks.state = { clineMessages: [message(10, withDraft)] }
		render(<NotebookChangesRow message={message(10, withDraft)} />)
		expect(screen.getByTestId("notebook-draft-notice")).toHaveTextContent("Your text is kept as a draft")
		fireEvent.click(screen.getByRole("button", { name: /^Retry saving your edit/ }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(
				expect.objectContaining({ action: "retry_draft", slug: "plan", revision: "r1" }),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: /^Reload your draft/ }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "reload_draft", slug: "plan" })),
		)
		fireEvent.click(screen.getByRole("button", { name: /^Discard your draft/ }))
		await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "discard_draft" })))
	})
	it("shows a failed Retry inline", async () => {
		const withDraft = { ...payload, changes: [{ ...payload.changes[0], draft: { ts: 5, reason: "stale" } }] }
		mocks.state = { clineMessages: [message(10, withDraft)] }
		mocks.action.mockRejectedValueOnce(new Error("Use the newest review card."))
		render(<NotebookChangesRow message={message(10, withDraft)} />)
		fireEvent.click(screen.getByRole("button", { name: /^Retry saving your edit/ }))
		expect(await screen.findByText("Use the newest review card.")).toBeInTheDocument()
	})
	it("accepts every change and renders a summary", async () => {
		render(<NotebookChangesRow message={message()} />)
		fireEvent.click(screen.getByRole("button", { name: "Accept all" }))
		await screen.findByText("Applied 1 notebook change")
		expect(mocks.apply).toHaveBeenCalledWith(
			expect.objectContaining({
				revision: "r1",
				taskGroupId: "g1",
				threadId: "t1",
				items: [{ slug: "plan", include: true }],
			}),
		)
	})
	it("discards all with the revision and renders a summary", async () => {
		render(<NotebookChangesRow message={message()} />)
		fireEvent.click(screen.getByRole("button", { name: "Discard all" }))
		await screen.findByText("Discarded notebook changes")
		expect(mocks.discard).toHaveBeenCalledWith(expect.objectContaining({ revision: "r1", taskGroupId: "g1", threadId: "t1" }))
	})
	it("keeps failed actions reviewable", async () => {
		mocks.apply.mockRejectedValue(new Error("stale revision"))
		render(<NotebookChangesRow message={message()} />)
		fireEvent.click(screen.getByRole("button", { name: "Accept all" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("stale revision")
		expect(screen.getByRole("button", { name: "Accept all" })).toBeEnabled()
	})
	it("shows the user edit row and offers restore when replaced", async () => {
		render(
			<NotebookChangesRow
				message={message(10, { ...payload, changes: [{ ...payload.changes[0], replacedUserVersion: "user1" }] })}
			/>,
		)
		expect(screen.getByText("agent replaced your edit")).toBeInTheDocument()
		expect(screen.getByText(/You edited Plan/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Restore" }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "restore_pending", slug: "plan" })),
		)
	})
	it("supersedes old pending cards while preserving resolved summaries", () => {
		mocks.state = { clineMessages: [message(), message(20)] }
		const { rerender } = render(<NotebookChangesRow message={message()} />)
		expect(screen.getByTestId("notebook-changes-superseded")).toBeInTheDocument()
		rerender(<NotebookChangesRow message={message(10, { ...payload, status: "discarded" })} />)
		expect(screen.getByText("Discarded notebook changes")).toBeInTheDocument()
	})
	it("rejects malformed payloads", () => {
		expect(parseNotebookChangesPayload("bad")).toBeNull()
		expect(parseNotebookChangesPayload(JSON.stringify({ threadId: "t1" }))).toBeNull()
	})
})
