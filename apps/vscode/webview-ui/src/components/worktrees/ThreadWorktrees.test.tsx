import type { ThreadWorktree, WorktreeState } from "@shared/thread-worktrees"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { ThreadWorktreeActions, WorktreeBadge } from "./ThreadWorktreeActions"
import { WorktreeSettings } from "./WorktreeSettings"
import { WorktreeToggle } from "./WorktreeToggle"

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
it("starts unchecked and updates the shared draft without a modal", async () => {
	render(<WorktreeToggle />)
	const toggle = screen.getByRole("menuitemcheckbox", { name: "Run in worktree" })
	await waitFor(() => expect(toggle).not.toBeDisabled())
	expect(toggle).not.toBeChecked()
	fireEvent.click(toggle)
	await waitFor(() => expect(toggle).toBeChecked())
	expect(screen.queryByRole("dialog")).toBeNull()
})
it("shows mode availability and the reason isolation is unavailable", async () => {
	mocks.state.availability = { ...mocks.state.availability, mode: "mm", available: false, reason: "Set the path to mm.js" }
	render(<WorktreeToggle />)
	expect(await screen.findByText("Set the path to mm.js")).toBeVisible()
	expect(screen.getByRole("menuitemcheckbox")).toBeDisabled()
})
it("renders the worktree badge and asks inline before discarding untransferred changes", async () => {
	mocks.state.mapping = mapping
	mocks.action.mockImplementation(async (request) => ({
		json: JSON.stringify(
			request.action === "state"
				? { state: mocks.state }
				: request.action === "remove" && !request.confirmed
					? { warning: "Changes were never brought in" }
					: { message: "Removed" },
		),
	}))
	render(
		<>
			<WorktreeBadge threadId="thread" />
			<ThreadWorktreeActions threadId="thread" />
		</>,
	)
	expect(await screen.findByLabelText("Thread runs in a worktree")).toHaveAttribute("title", "/isolate")
	fireEvent.click(await screen.findByRole("menuitem", { name: "Remove worktree" }))
	expect(await screen.findByText("Changes were never brought in")).toBeVisible()
	fireEvent.click(screen.getByRole("menuitem", { name: "Remove and discard changes" }))
	await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "remove", confirmed: true })))
	expect(screen.queryByRole("dialog")).toBeNull()
})
it("shows undo conflict paths inline", async () => {
	mocks.state.mapping = mapping
	mocks.action.mockImplementation(async (request) => ({
		json: JSON.stringify(
			request.action === "state"
				? { state: mocks.state }
				: { conflicts: ["api/file.ts"], message: "Resolve conflict markers" },
		),
	}))
	render(<ThreadWorktreeActions threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Undo bring-in" }))
	expect(await screen.findByText("Conflict: api/file.ts")).toBeVisible()
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
