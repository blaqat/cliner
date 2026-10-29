import type { WorktreeState } from "@shared/thread-worktrees"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { clearDraftRunInWorktree, getDraftRunInWorktree } from "@/components/worktrees/useWorktree"
import { ThreadBranchChip, WorkspaceButton } from "./worktreeSlot"

const mocks = vi.hoisted(() => ({
	state: {} as WorktreeState,
	currentTaskItem: undefined as { id: string; isSubagent?: boolean } | undefined,
	navigateToSettings: vi.fn(),
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ currentTaskItem: mocks.currentTaskItem, navigateToSettings: mocks.navigateToSettings }),
}))
vi.mock("@/services/grpc-client", () => ({
	WorktreeServiceClient: {
		threadWorktreeAction: async (request: { action: string }) => ({
			json: JSON.stringify(
				request.action === "summary"
					? {
							summary: {
								changedFiles: 1,
								commits: 0,
								uncommittedFiles: 1,
								uncopiedFiles: 1,
								copied: false,
								canUndo: false,
								loseOnRemove: 1,
								workspaceDirty: false,
								takenOver: false,
							},
						}
					: { state: mocks.state },
			),
		}),
	},
}))

const withMode = (mode: "off" | "git" | "mm", extra: Partial<WorktreeState["availability"]> = {}): WorktreeState => ({
	settings: { mode, mmPath: "", nodePath: "node" },
	availability: { mode, available: mode !== "off", hasMmrc: mode === "mm", workspaceOff: false, ...extra },
	settled: [],
})

const openMenu = async () => {
	fireEvent.click(screen.getByTestId("workspace-button"))
	return screen.findByTestId("workspace-menu")
}

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	clearDraftRunInWorktree()
	mocks.state = withMode("git")
	mocks.currentTaskItem = undefined
	mocks.navigateToSettings.mockReset()
})

it("lets a new thread pick a worktree, and the button and send path follow the pick", async () => {
	render(<WorkspaceButton />)
	expect(screen.getByTestId("workspace-button")).toHaveAccessibleName("Workspace: your workspace")
	// "Your workspace" with a folder; a picked worktree reads "New worktree" with the green worktree icon.
	expect(screen.getByTestId("workspace-button")).toHaveTextContent(/^Your workspace$/)
	expect(screen.getByTestId("workspace-button").querySelector(".codicon-folder")).not.toBeNull()
	await openMenu()
	const worktree = screen.getByRole("menuitemradio", { name: /New worktree/ })
	await waitFor(() => expect(worktree).not.toBeDisabled())
	fireEvent.click(worktree)
	expect(getDraftRunInWorktree()).toBe(true)
	expect(screen.getByTestId("workspace-button")).toHaveAttribute("data-worktree", "true")
	expect(screen.getByTestId("workspace-button")).toHaveTextContent(/^New worktree$/)
	expect(screen.getByTestId("workspace-button").querySelector(".codicon-repo-forked")).not.toBeNull()
})

it("never leaves the user stuck: worktrees off still opens a menu with a link to Settings", async () => {
	mocks.state = withMode("off")
	render(<WorkspaceButton />)
	await openMenu()
	await waitFor(() => expect(screen.getByTestId("workspace-blocker")).toHaveTextContent("Worktrees are off."))
	expect(screen.getByTestId("workspace-settings")).toHaveTextContent("Turn on in Settings")
	expect(screen.getByRole("menuitemradio", { name: /New worktree/ })).toBeDisabled()
	fireEvent.click(screen.getByTestId("workspace-settings"))
	expect(mocks.navigateToSettings).toHaveBeenCalledWith("worktrees")
})

it("explains an mm setup gap and links to set it up", async () => {
	mocks.state = withMode("mm", { available: false, reason: "Set the path to mm.js in Worktrees settings" })
	render(<WorkspaceButton />)
	await openMenu()
	await waitFor(() =>
		expect(screen.getByTestId("workspace-blocker")).toHaveTextContent("Set the path to mm.js in Worktrees settings"),
	)
	expect(screen.getByTestId("workspace-settings")).toHaveTextContent("Set up mm in Settings")
})

it("in a worktree thread the header's branch chip opens the worktree menu", async () => {
	mocks.currentTaskItem = { id: "t1" }
	mocks.state = {
		...withMode("git"),
		mapping: {
			threadId: "t1",
			mode: "git",
			branch: "cline/t1",
			workspace: "/w",
			cwd: "/i",
			modules: [],
			createdAt: 1,
			bringIns: [],
		},
	}
	render(<ThreadBranchChip />)
	const chip = await screen.findByTestId("thread-branch-chip")
	expect(chip).toHaveAccessibleName("Worktree: cline/t1")
	expect(chip).toHaveTextContent(/^cline\/t1$/)
	expect(chip.querySelector(".font-mono")).toHaveTextContent("cline/t1")
	expect(chip.querySelector(".codicon-git-branch")).toHaveClass("text-(--vscode-charts-green)")
	fireEvent.click(chip)
	await screen.findByTestId("workspace-menu")
	expect(screen.getByTestId("workspace-current")).toHaveTextContent("cline/t1")
	expect(screen.queryByRole("menuitemradio")).toBeNull()
	// The worktree's actions, under the branch.
	const actions = await screen.findByTestId("worktree-actions")
	await waitFor(() => expect(within(actions).getByTestId("worktree-status")).toHaveTextContent("1 file changed"))
	for (const name of ["Open in new window", /Copy changes here/, "Switch workspace to this branch", "Remove worktree"])
		expect(within(actions).getByRole("menuitem", { name })).toBeInTheDocument()
	// Nothing was copied, so there's no Undo to offer.
	expect(within(actions).queryByRole("menuitem", { name: "Undo the copy" })).toBeNull()
	expect(screen.getByTestId("workspace-menu")).toHaveClass("w-72")
	expect(screen.getByTestId("workspace-settings")).toHaveTextContent("Worktree settings")
})

it("is hidden in subagent threads, which run where their parent does", () => {
	mocks.currentTaskItem = { id: "sub", isSubagent: true }
	const { container } = render(
		<>
			<WorkspaceButton />
			<ThreadBranchChip />
		</>,
	)
	expect(container).toBeEmptyDOMElement()
})

it("has no branch chip for a thread in your workspace, or with no thread", async () => {
	const { container, rerender } = render(<ThreadBranchChip />)
	expect(container).toBeEmptyDOMElement()
	mocks.currentTaskItem = { id: "t2" }
	rerender(<ThreadBranchChip />)
	// Its state loads, and still no worktree: nothing to show.
	await waitFor(() => expect(container).toBeEmptyDOMElement())
})
