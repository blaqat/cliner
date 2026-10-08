import type { QueuedPrompt } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueuedPrompts } from "./QueuedPrompts"

const cancelQueuedPromptMock = vi.hoisted(() => vi.fn())
const interjectPromptMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		cancelQueuedPrompt: (request: unknown) => cancelQueuedPromptMock(request),
		interjectPrompt: (request: unknown) => interjectPromptMock(request),
	},
}))

vi.mock("@shared/proto/cline/common", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shared/proto/cline/common")>()),
	StringRequest: {
		create: (request: unknown) => request,
	},
}))

const queuedPrompts: QueuedPrompt[] = [
	{
		id: "prompt-1",
		prompt: "First queued message",
		delivery: "queue",
		attachmentCount: 0,
	},
	{
		id: "prompt-2",
		prompt: "Second queued message",
		delivery: "steer",
		attachmentCount: 1,
	},
]

describe("QueuedPrompts", () => {
	beforeEach(() => {
		cancelQueuedPromptMock.mockReset()
		cancelQueuedPromptMock.mockResolvedValue({})
		interjectPromptMock.mockReset()
		interjectPromptMock.mockResolvedValue({})
	})

	it("interjects a queued prompt now: removes it from the queue, then interjects", async () => {
		render(<QueuedPrompts items={queuedPrompts} />)

		const interjectButtons = screen.getAllByRole("button", { name: "Interject now" })
		fireEvent.click(interjectButtons[0])

		expect(cancelQueuedPromptMock).toHaveBeenCalledWith({ value: "prompt-1" })
		await waitFor(() =>
			expect(interjectPromptMock).toHaveBeenCalledWith(expect.objectContaining({ text: "First queued message" })),
		)
		// Attachments are not exposed by the queue, so those prompts can't be interjected from here.
		expect(interjectButtons[1]).toBeDisabled()
	})

	it("cancels a queued prompt from the row action", async () => {
		render(<QueuedPrompts items={queuedPrompts} />)

		const cancelButtons = screen.getAllByRole("button", { name: "Cancel queued message" })
		fireEvent.click(cancelButtons[0])

		expect(cancelQueuedPromptMock).toHaveBeenCalledTimes(1)
		expect(cancelQueuedPromptMock).toHaveBeenCalledWith({ value: "prompt-1" })
		expect(cancelButtons[0]).toBeDisabled()

		await waitFor(() => expect(cancelButtons[0]).not.toBeDisabled())
	})

	it("does not render an empty queue", () => {
		const { container } = render(<QueuedPrompts items={[]} />)

		expect(container).toBeEmptyDOMElement()
	})
})
