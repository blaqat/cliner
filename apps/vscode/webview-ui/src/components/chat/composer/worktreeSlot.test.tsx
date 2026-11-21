import type { WorktreeState } from "@shared/thread-worktrees"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import {
	clearDraftRunInWorktree,
	clearWorktreeStartFailure,
	getDraftRunInWorktree,
	reportWorktreeStartFailure,
	threadWorktreeAction,
} from "@/components/worktrees/useWorktree"
import { ThreadBranchChip, WorkspaceButton, WorktreeStartNotice } from "./worktreeSlot"

const mocks = vi.hoisted(() => ({
	state: {} as WorktreeState,
	currentTaskItem: undefined as { id: string; isSubagent?: boolean } | undefined,
	navigateToSettings: vi.fn(),
	stateRequest: vi.fn(),
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		currentTaskItem: mocks.currentTaskItem,
		navigateToSettings: mocks.navigateToSettings,
		worktreesEnabled: { featureFlag: false, user: false },
	}),
}))
vi.mock("@/services/grpc-client", () => ({
	WorktreeServiceClient: {
		threadWorktreeAction: async (request: { action: string; json: string }) => {
			if (request.action === "state") mocks.stateRequest(request.json)
			return {
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
			}
		},
	},
}))

const withMode = (mode: "off" | "git" | "mm", extra: Partial<WorktreeState["availability"]> = {}): WorktreeState => ({
	settings: { mode, mmPath: "", nodePath: "node" },
	availability: { mode, available: mode !== "off", workspaceOff: false, ...extra },
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
	clearWorktreeStartFailure()
	mocks.state = withMode("git")
	mocks.currentTaskItem = undefined
	mocks.navigateToSettings.mockReset()
	mocks.stateRequest.mockReset()
})

it("lets a new thread pick a worktree with upstream's rollout off, and the button and send path follow the pick", async () => {
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
	expect(screen.getByTestId("workspace-settings")).toHaveTextContent("Open Worktrees settings")
})

it.each([
	"This mm doesn't list its modules yet. Update mm.js. mm.js path: /tools/old-mm",
	"Couldn't read mm configuration. .mm.json is not valid JSON. Config: /repo/.mm.json mm.js path: /tools/mm.js",
])("displays the mm error and links directly to Worktrees settings", async (reason) => {
	mocks.state = withMode("mm", { available: false, reason })
	render(<WorkspaceButton />)
	const menu = await openMenu()
	await waitFor(() => expect(within(menu).getByTestId("workspace-blocker")).toHaveTextContent(reason))
	expect(within(menu).getByTestId("workspace-worktree")).toBeDisabled()
	fireEvent.click(within(menu).getByRole("menuitem", { name: "Open Worktrees settings" }))
	expect(mocks.navigateToSettings).toHaveBeenCalledWith("worktrees")
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

it("says when a new thread couldn't start for its worktree, with the fix and a way around it", async () => {
	render(
		<>
			<WorktreeStartNotice />
			<WorkspaceButton />
		</>,
	)
	expect(screen.queryByTestId("worktree-start-failure")).toBeNull()
	fireEvent.click(within(await openMenu()).getByTestId("workspace-worktree"))
	expect(getDraftRunInWorktree()).toBe(true)

	act(() => reportWorktreeStartFailure(new Error("Error: Failed to start task: mm is not on PATH")))
	const notice = await screen.findByTestId("worktree-start-failure")
	expect(notice).toHaveTextContent("Couldn't make a worktree for this thread. mm is not on PATH")
	fireEvent.click(within(notice).getByRole("button", { name: "Use your workspace instead" }))
	expect(getDraftRunInWorktree()).toBe(false)
	expect(screen.queryByTestId("worktree-start-failure")).toBeNull()

	act(() => reportWorktreeStartFailure("Error: git worktree add failed"))
	fireEvent.click(
		within(await screen.findByTestId("worktree-start-failure")).getByRole("button", { name: "Worktree settings" }),
	)
	expect(mocks.navigateToSettings).toHaveBeenCalledWith("worktrees")
	expect(screen.queryByTestId("worktree-start-failure")).toBeNull()
})

it("offers an mm worktree as soon as a valid mm.js path is saved, without a restart", async () => {
	const unset = withMode("mm", { available: false, reason: "Set the path to mm.js in Worktrees settings" })
	mocks.state = unset
	render(<WorkspaceButton />)
	const menu = await openMenu()
	await waitFor(() => expect(within(menu).getByTestId("workspace-worktree")).toBeDisabled())
	expect(within(menu).getByTestId("workspace-settings")).toHaveTextContent("Open Worktrees settings")
	// Settings saves while the composer's menu stays mounted.
	const saved = { mode: "mm" as const, mmPath: "/tools/mm.js", nodePath: "node" }
	mocks.state = { ...withMode("mm"), settings: saved }
	await act(() => threadWorktreeAction("configure", "", saved))
	await waitFor(() => expect(within(menu).getByTestId("workspace-worktree")).toBeEnabled())
	expect(within(menu).queryByTestId("workspace-blocker")).toBeNull()
	expect(within(menu).getByTestId("workspace-settings")).toHaveTextContent("Worktree settings")
})

it("re-checks worktree availability each time the workspace menu opens", async () => {
	mocks.state = withMode("mm", { available: false, reason: "Set the path to mm.js in Worktrees settings" })
	render(<WorkspaceButton />)
	await waitFor(() => expect(screen.getByTestId("workspace-button")).toBeInTheDocument())
	expect(mocks.stateRequest).toHaveBeenCalledWith("")
	mocks.stateRequest.mockClear()
	// Another window saved the path; this one hears nothing until its menu opens.
	mocks.state = withMode("mm")
	const menu = await openMenu()
	await waitFor(() => expect(within(menu).getByTestId("workspace-worktree")).toBeEnabled())
	expect(mocks.stateRequest).toHaveBeenCalledWith(JSON.stringify({ refreshMm: true }))
})
