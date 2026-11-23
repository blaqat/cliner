import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import UserMessage from "./UserMessage"

const checkpointExistsForMessage = vi.fn()
const checkpointRestoreBlockForMessage = vi.fn()

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		currentTaskItem: { id: "task-1" },
		navigateToSettings: vi.fn(),
		enableCheckpointsSetting: true,
		subagentView: undefined,
	}),
}))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { buildMessageLink: vi.fn(), editMessageAndRegenerate: vi.fn(), openMessageLink: vi.fn() },
	CheckpointsServiceClient: {
		checkpointExistsForMessage: (request: unknown) => checkpointExistsForMessage(request),
		checkpointRestoreBlockForMessage: (request: unknown) => checkpointRestoreBlockForMessage(request),
	},
}))
vi.mock("@/components/inbox/sessionActions", () => ({ openTask: vi.fn() }))

const SHARED = "This thread shares a task worktree. Restore the conversation to keep other threads' changes."

describe("UserMessage Reset Code", () => {
	beforeEach(() => {
		checkpointExistsForMessage.mockReset().mockResolvedValue({ value: false })
		checkpointRestoreBlockForMessage.mockReset().mockResolvedValue({ value: "" })
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	const openEditor = () => {
		render(<UserMessage canRestoreWorkspace messageTs={5} text="redo it" />)
		fireEvent.click(screen.getByRole("button", { name: "Edit and regenerate from this message" }))
	}

	it("says why it can't reset files in a shared worktree, not that there's no checkpoint", async () => {
		checkpointRestoreBlockForMessage.mockResolvedValue({ value: SHARED })
		openEditor()
		const button = await screen.findByRole("button", { name: "Reset Code" })
		await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"))
		fireEvent.focus(button)
		expect(await screen.findAllByText(SHARED)).not.toHaveLength(0)
		expect(screen.queryByText("No workspace checkpoint was created for this message.")).toBeNull()
	})

	it("keeps the plain reason when nothing blocks the restore and there's no checkpoint", async () => {
		openEditor()
		const button = await screen.findByRole("button", { name: "Reset Code" })
		await waitFor(() => expect(checkpointRestoreBlockForMessage).toHaveBeenCalled())
		fireEvent.focus(button)
		expect(await screen.findAllByText("No workspace checkpoint was created for this message.")).not.toHaveLength(0)
	})

	it("doesn't ask why when a checkpoint exists", async () => {
		checkpointExistsForMessage.mockResolvedValue({ value: true })
		openEditor()
		const button = await screen.findByRole("button", { name: "Reset Code" })
		await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"))
		expect(checkpointRestoreBlockForMessage).not.toHaveBeenCalled()
	})
})
