import type { ThreadWorktree, WorktreeState, WorktreeSummary } from "@shared/thread-worktrees"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadWorktreeActions, worktreeStatusText } from "./ThreadWorktreeActions"
import { WorktreeSettings } from "./WorktreeSettings"

const mocks = vi.hoisted(() => ({ action: vi.fn(), state: {} as WorktreeState, thread: 0 }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ currentTaskItem: { id: String(mocks.thread) } }),
}))
vi.mock("@/services/grpc-client", () => ({
	WorktreeServiceClient: { threadWorktreeAction: (request: unknown) => mocks.action(request) },
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, checked, disabled, onChange }: any) => (
		<label>
			<input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))
// Radix Select measures and captures the pointer; jsdom has neither.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.scrollIntoView ??= () => {}
const mapping: ThreadWorktree = {
	threadId: "thread",
	mode: "git",
	branch: "cline/test",
	workspace: "/workspace",
	cwd: "/isolate",
	modules: [],
	createdAt: 1,
	bringIns: [],
}
beforeEach(() => {
	mocks.thread++
	mocks.state = {
		settings: { mode: "git", mmPath: "", nodePath: "node" },
		availability: { mode: "git", available: true, hasMmrc: false, workspaceOff: false },
		settled: [],
	}
	mocks.action.mockReset().mockImplementation(async (request) => ({
		json: JSON.stringify(request.action === "state" ? { state: mocks.state } : {}),
	}))
})
const SUMMARY: WorktreeSummary = {
	changedFiles: 2,
	commits: 1,
	uncommittedFiles: 1,
	uncopiedFiles: 2,
	copied: false,
	canUndo: false,
	loseOnRemove: 2,
	workspaceDirty: false,
	takenOver: false,
}
/** Answers "summary" with `summary` (updated by `after`) and every other action with `results[action]`. */
function serve(summary: WorktreeSummary, results: Record<string, object | ((request: any) => object)> = {}) {
	let current = summary
	mocks.action.mockImplementation(async (request) => {
		if (request.action === "summary") return { json: JSON.stringify({ summary: current }) }
		const result = results[request.action]
		const value = typeof result === "function" ? result(request) : (result ?? {})
		if ("after" in value) current = (value as { after: WorktreeSummary }).after
		return { json: JSON.stringify(value) }
	})
}
const rowNames = () => screen.getAllByRole("menuitem").map((row) => row.textContent)
const status = () => screen.getByTestId("worktree-status")

it("says where the changes stand and lists only what applies", async () => {
	serve(SUMMARY)
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	await waitFor(() => expect(status()).toHaveTextContent("2 files changed · 1 commit · not copied here"))
	expect(screen.getByTestId("workspace-current")).toHaveTextContent("cline/test")
	// Nothing was copied, so there's nothing to undo.
	expect(rowNames()).toEqual([
		"Open in new window",
		"Copy changes here2 files",
		"Switch workspace to this branch",
		"Remove worktree",
	])
})

it("reports a copy on the status line with Undo, and only then lists Undo", async () => {
	const copied = { ...SUMMARY, uncopiedFiles: 0, copied: true, canUndo: true, loseOnRemove: 0, workspaceDirty: true }
	serve(SUMMARY, { bring: { message: "Copied 2 files into your workspace", files: 2, after: copied } })
	const onChanged = vi.fn(async () => {})
	render(<ThreadWorktreeActions mapping={mapping} onChanged={onChanged} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: /Copy changes here/ }))
	await waitFor(() => expect(status()).toHaveTextContent("Copied 2 files into your workspace·Undo"))
	expect(status()).toHaveAttribute("data-tone", "ok")
	expect(onChanged).toHaveBeenCalled()
	expect(rowNames()).toEqual(["Open in new window", "Undo the copy", "Switch workspace to this branch", "Remove worktree"])
	// The copy made the workspace dirty: switching says what to do first.
	expect(screen.getByRole("menuitem", { name: "Switch workspace to this branch" })).toBeDisabled()
	expect(screen.getByTestId("worktree-switch-hint")).toHaveTextContent("Undo the copy (or commit it) first")
	// No notice box: the menu is the same rows plus the hint.
	expect(screen.queryByRole("alert")).toBeNull()
})

it("links to Source Control when the workspace's own changes block switching", async () => {
	serve({ ...SUMMARY, workspaceDirty: true })
	const onClose = vi.fn()
	render(<ThreadWorktreeActions mapping={mapping} onClose={onClose} threadId="thread" />)
	const hint = await screen.findByTestId("worktree-switch-hint")
	expect(hint).toHaveTextContent("Workspace has uncommitted changes · Source Control")
	fireEvent.click(within(hint).getByRole("button", { name: "Source Control" }))
	expect(onClose).toHaveBeenCalled()
	expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "sourceControl" }))
})

it("asks on the Remove row itself before losing uncopied files", async () => {
	serve(SUMMARY, { remove: { message: "Worktree removed" } })
	const onChanged = vi.fn(async () => {})
	render(<ThreadWorktreeActions mapping={mapping} onChanged={onChanged} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Remove worktree" }))
	const confirm = screen.getByTestId("worktree-remove-confirm")
	expect(confirm).toHaveTextContent("Lose 2 uncopied files?")
	expect(confirm).toHaveClass("h-6")
	expect(mocks.action).not.toHaveBeenCalledWith(expect.objectContaining({ action: "remove" }))
	fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }))
	expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeInTheDocument()
	fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }))
	fireEvent.click(within(screen.getByTestId("worktree-remove-confirm")).getByRole("button", { name: "Remove" }))
	await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "remove", confirmed: true })))
	await waitFor(() => expect(onChanged).toHaveBeenCalled())
	expect(screen.queryByRole("dialog")).toBeNull()
})

it("removes without asking when nothing would be lost", async () => {
	serve({ ...SUMMARY, uncopiedFiles: 0, copied: true, loseOnRemove: 0 }, { remove: { message: "Worktree removed" } })
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Remove worktree" }))
	await waitFor(() =>
		expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "remove", confirmed: false })),
	)
	expect(screen.queryByTestId("worktree-remove-confirm")).toBeNull()
})

it("after switching, says so and offers only removing the leftover folder", async () => {
	const switched = { ...SUMMARY, takenOver: true, loseOnRemove: 0, workspaceDirty: true }
	serve(SUMMARY, {
		takeOver: { message: "Your workspace is on this branch now, with its 1 uncommitted file", files: 1, after: switched },
	})
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Switch workspace to this branch" }))
	await waitFor(() => expect(rowNames()).toEqual(["Remove the leftover worktree folder"]))
	expect(status()).toHaveTextContent("Your workspace is on this branch now, with its 1 uncommitted file")
	expect(status()).toHaveAttribute("data-tone", "ok")
})

it("shows a blocked action's reason on the status line, not in a new box", async () => {
	serve(SUMMARY, {
		bring: () => {
			throw new Error("Error: Your workspace has its own changes to `file.txt` that clash with this thread's.")
		},
	})
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: /Copy changes here/ }))
	await waitFor(() => expect(status()).toHaveAttribute("data-tone", "warning"))
	expect(status()).toHaveTextContent("Your workspace has its own changes to `file.txt` that clash with this thread's.")
	expect(status()).not.toHaveTextContent("Error:")
	expect(within(status()).getByRole("button", { name: "Source Control" })).toBeInTheDocument()
})

it("lists undo conflicts on the status line", async () => {
	serve({ ...SUMMARY, canUndo: true, copied: true }, { undo: { conflicts: ["api/file.ts"], message: "Undid the copy." } })
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Undo the copy" }))
	await waitFor(() => expect(status()).toHaveTextContent("Undid the copy. api/file.ts"))
})

it("waits for a running thread before copying, switching or removing", async () => {
	serve({ ...SUMMARY, running: true })
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	await waitFor(() => expect(screen.getByRole("menuitem", { name: /Copy changes here/ })).toBeDisabled())
	expect(screen.getByRole("menuitem", { name: "Switch workspace to this branch" })).toBeDisabled()
	expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeDisabled()
	expect(screen.getByTestId("worktree-switch-hint")).toHaveTextContent("Wait for the thread to finish")
})

describe("worktreeStatusText", () => {
	it("words each state", () => {
		expect(worktreeStatusText({ ...SUMMARY, changedFiles: 0, commits: 0 })).toBe("No changes yet")
		expect(worktreeStatusText({ ...SUMMARY, changedFiles: 1, commits: 0, uncopiedFiles: 1 })).toBe(
			"1 file changed · not copied here",
		)
		expect(worktreeStatusText({ ...SUMMARY, uncopiedFiles: 0, copied: true })).toBe(
			"2 files changed · 1 commit · copied here",
		)
		expect(worktreeStatusText({ ...SUMMARY, uncopiedFiles: 1, copied: true })).toBe(
			"2 files changed · 1 commit · 1 not copied yet",
		)
	})
})
it("saves mode and paths and provides selective settled-worktree cleanup", async () => {
	mocks.state.settled = [mapping, { ...mapping, threadId: "keep", branch: "cline/keep" }]
	render(<WorktreeSettings />)
	expect(await screen.findByText("2 settled worktrees")).toBeVisible()
	fireEvent.keyDown(screen.getByRole("combobox", { name: "Worktrees mode" }), { key: "Enter" })
	fireEvent.keyDown(await screen.findByRole("option", { name: "mm" }), { key: "Enter" })
	fireEvent.change(await screen.findByLabelText("Path to mm.js"), { target: { value: "/tools/mm.js" } })
	fireEvent.click(screen.getByText("Save worktree settings"))
	await waitFor(() =>
		expect(mocks.action).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "configure",
				json: JSON.stringify({ mode: "mm", mmPath: "/tools/mm.js", nodePath: "node" }),
			}),
		),
	)
	fireEvent.click(screen.getByRole("checkbox", { name: /cline\/test/ }))
	fireEvent.click(screen.getByText("Remove 1 selected"))
	await waitFor(() =>
		expect(mocks.action).toHaveBeenCalledWith(
			expect.objectContaining({ action: "remove", threadId: "thread", confirmed: false }),
		),
	)
	expect(mocks.action).not.toHaveBeenCalledWith(expect.objectContaining({ action: "remove", threadId: "keep" }))
})
