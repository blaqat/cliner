import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { NotebookNoteView } from "./NotebookNoteView"

const action = vi.hoisted(() => vi.fn())
vi.mock("@/services/grpc-client", () => ({ TaskGroupServiceClient: { notebookAction: action } }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ hideTaskGroupView: vi.fn(), navigateToTaskGroup: vi.fn() }),
}))
vi.mock("@/components/common/MarkdownBlock", () => ({ default: ({ markdown }: { markdown: string }) => <div>{markdown}</div> }))
const data = {
	versions: [
		{
			id: "v1",
			ts: 1,
			content: "original",
			by: "thread",
			diff: [
				{ kind: "remove", text: "original" },
				{ kind: "add", text: "current" },
			],
		},
		{ id: "v2", ts: 2, content: "current", by: "you", diff: [] },
	],
	conversions: [],
}
const renderNote = () =>
	render(
		<NotebookNoteView
			note={{ slug: "plan", name: "Plan", description: "", size: 1, updatedAt: 1, updatedBy: { kind: "user" }, readers: 0 }}
			onBack={vi.fn()}
			taskGroupId="g1"
			taskTitle="Task"
		/>,
	)
beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	action.mockReset().mockImplementation(async (request) => ({
		json: JSON.stringify(
			request.action === "convert_preview"
				? { path: ".clinerules/plan.md", content: "current", revision: "preview1" }
				: data,
		),
	}))
})
it("opens a history breadcrumb page and compares an original version against current before restore", async () => {
	renderNote()
	await screen.findByText("current")
	fireEvent.click(screen.getByRole("button", { name: "History" }))
	await screen.findByText("2 versions")
	fireEvent.click(screen.getByRole("button", { name: /Original/ }))
	expect(screen.getByText("Selected version → current")).toBeInTheDocument()
	expect(screen.getByText("−original")).toBeInTheDocument()
	fireEvent.click(screen.getByRole("button", { name: "Restore" }))
	await waitFor(() => expect(action).toHaveBeenCalledWith(expect.objectContaining({ action: "restore", versionId: "v1" })))
})
it("reviews a workspace rule inline before creating it", async () => {
	renderNote()
	await screen.findByText("current")
	fireEvent.click(screen.getByRole("button", { name: "Convert to…" }))
	fireEvent.click(screen.getByRole("button", { name: "Rule" }))
	expect(screen.queryByLabelText("Skill description")).not.toBeInTheDocument()
	fireEvent.click(screen.getByRole("button", { name: "Review file" }))
	await screen.findByText(".clinerules/plan.md")
	expect(action).not.toHaveBeenCalledWith(expect.objectContaining({ action: "convert" }))
	fireEvent.click(screen.getByRole("button", { name: "Create file" }))
	await waitFor(() =>
		expect(action).toHaveBeenCalledWith(
			expect.objectContaining({ action: "convert", kind: "rule", isGlobal: false, versionId: "preview1" }),
		),
	)
})
it("requires a description only for skills and allows Global selection", async () => {
	renderNote()
	await screen.findByText("current")
	fireEvent.click(screen.getByRole("button", { name: "Convert to…" }))
	fireEvent.click(screen.getByRole("button", { name: "Skill" }))
	expect(screen.getByRole("button", { name: "Review file" })).toBeDisabled()
	fireEvent.change(screen.getByLabelText("Skill description"), { target: { value: "When planning exports" } })
	fireEvent.click(screen.getByRole("button", { name: "Global" }))
	fireEvent.click(screen.getByRole("button", { name: "Review file" }))
	await waitFor(() =>
		expect(action).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "skill", isGlobal: true, description: "When planning exports" }),
		),
	)
})
