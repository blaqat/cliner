import type { WorktreeState } from "@shared/thread-worktrees"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { clearDraftRunInWorktree, getDraftRunInWorktree } from "@/components/worktrees/useWorktree"
import { WorkspaceButton } from "./worktreeSlot"

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
		threadWorktreeAction: async () => ({ json: JSON.stringify({ state: mocks.state }) }),
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
	await openMenu()
	const worktree = screen.getByRole("menuitemradio", { name: /New worktree/ })
	await waitFor(() => expect(worktree).not.toBeDisabled())
	fireEvent.click(worktree)
	expect(getDraftRunInWorktree()).toBe(true)
	expect(screen.getByTestId("workspace-button")).toHaveAttribute("data-worktree", "true")
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

it("shows where an existing thread runs instead of a choice", async () => {
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
	render(<WorkspaceButton />)
	await waitFor(() => expect(screen.getByTestId("workspace-button")).toHaveAccessibleName("Workspace: worktree cline/t1"))
	await openMenu()
	expect(screen.getByTestId("workspace-current")).toHaveTextContent("cline/t1")
	expect(screen.queryByRole("menuitemradio")).toBeNull()
	// The worktree's actions live here now, under the branch (not in the thread header).
	const actions = await screen.findByTestId("worktree-actions")
	for (const name of ["Open in new window", "Bring here", "Undo bring-in", "Take over branch", "Remove worktree"])
		expect(within(actions).getByRole("menuitem", { name })).toBeInTheDocument()
	expect(screen.getByTestId("workspace-settings")).toHaveTextContent("Worktree settings")
})

it("is hidden in subagent threads, which run where their parent does", () => {
	mocks.currentTaskItem = { id: "sub", isSubagent: true }
	const { container } = render(<WorkspaceButton />)
	expect(container).toBeEmptyDOMElement()
})
