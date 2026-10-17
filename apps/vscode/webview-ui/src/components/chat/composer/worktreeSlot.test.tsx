import type { WorktreeState } from "@shared/thread-worktrees"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { clearDraftRunInWorktree, getDraftRunInWorktree } from "@/components/worktrees/useWorktree"
import { WorktreeBadgeSlot, WorktreeToggleSlot } from "./worktreeSlot"

const mocks = vi.hoisted(() => ({ state: {} as WorktreeState }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ currentTaskItem: undefined }),
}))
vi.mock("@/services/grpc-client", () => ({
	WorktreeServiceClient: {
		threadWorktreeAction: async () => ({ json: JSON.stringify({ state: mocks.state }) }),
	},
}))

const withMode = (mode: "off" | "git"): WorktreeState => ({
	settings: { mode, mmPath: "", nodePath: "node" },
	availability: { mode, available: mode !== "off", hasMmrc: false, workspaceOff: false },
	settled: [],
})

beforeEach(() => {
	clearDraftRunInWorktree()
	mocks.state = withMode("git")
})

it("renders nothing while worktrees are off", async () => {
	mocks.state = withMode("off")
	const { container } = render(<WorktreeToggleSlot />)
	await new Promise((resolve) => setTimeout(resolve, 0))
	expect(container).toBeEmptyDOMElement()
})

it("lets a new thread opt in, and the pill badge and send path follow the draft", async () => {
	render(
		<>
			<WorktreeToggleSlot />
			<WorktreeBadgeSlot />
		</>,
	)
	const toggle = await screen.findByRole("menuitemcheckbox", { name: /Run in worktree/ })
	await waitFor(() => expect(toggle).not.toBeDisabled())
	expect(screen.queryByLabelText("runs in a worktree")).toBeNull()
	fireEvent.click(toggle)
	expect(getDraftRunInWorktree()).toBe(true)
	expect(await screen.findByLabelText("runs in a worktree")).toBeInTheDocument()
})

it("shows where an existing thread runs instead of a toggle", async () => {
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
	render(<WorktreeToggleSlot threadId="t1" />)
	expect(await screen.findByText("cline/t1")).toBeInTheDocument()
	expect(screen.queryByRole("menuitemcheckbox")).toBeNull()
})
