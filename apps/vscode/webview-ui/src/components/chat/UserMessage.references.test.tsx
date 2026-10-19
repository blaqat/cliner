import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import UserMessage from "./UserMessage"

const editMessageAndRegenerate = vi.fn()

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		currentTaskItem: { id: "task-1" },
		navigateToSettings: vi.fn(),
		enableCheckpointsSetting: false,
		subagentView: undefined,
	}),
}))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		buildMessageLink: vi.fn(),
		editMessageAndRegenerate: (request: unknown) => editMessageAndRegenerate(request),
	},
	CheckpointsServiceClient: { checkpointExistsForMessage: vi.fn(() => Promise.resolve({ value: false })) },
}))

const REF = { threadId: "7_src", threadTitle: "Dev plan", author: "user" as const, text: "Cap exports at 10k rows" }
const REF_2 = { threadId: "8_src", threadTitle: "Infra", author: "assistant" as const, text: "Use the queue." }
const RAW_BLOCK = `<message_reference thread_id="7_src" thread_title="Dev plan" author="user">\nCap exports at 10k rows\n</message_reference>`

describe("UserMessage message tags", () => {
	beforeEach(() => {
		editMessageAndRegenerate.mockReset().mockResolvedValue({})
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("renders each tag as a chip with its source and no raw markup", () => {
		render(<UserMessage messageReferences={[REF, REF_2]} messageTs={5} text="use these" />)
		expect(screen.getAllByTestId("message-tag-source").map((el) => el.textContent)).toEqual([
			"You · Dev plan",
			"Cline · Infra",
		])
		expect(screen.getByText("use these")).toBeInTheDocument()
		expect(document.body.textContent).not.toContain("message_reference")
		expect(screen.queryByRole("button", { name: "Remove message" })).toBeNull()
	})

	it("shows the linked message on hover", async () => {
		render(<UserMessage messageReferences={[REF]} messageTs={5} text="use this" />)
		fireEvent.pointerEnter(screen.getByRole("button", { name: /^Message from You · Dev plan/ }))
		expect(await screen.findByTestId("message-tag-text")).toHaveTextContent("Cap exports at 10k rows")
	})

	it("never shows a raw block that reached the bubble as text; it becomes a chip instead", () => {
		render(<UserMessage messageTs={5} text={`${RAW_BLOCK}\n\nuse this`} />)
		expect(screen.getByTestId("message-tag-source")).toHaveTextContent("You · Dev plan")
		expect(document.body.textContent).not.toContain("message_reference")
		expect(document.body.textContent).not.toContain("thread_id")
	})

	it("hovering a chip does not open the editor", () => {
		render(<UserMessage messageReferences={[REF]} messageTs={5} text="use this" />)
		fireEvent.click(screen.getByTestId("message-reference-tags"))
		expect(screen.queryByRole("textbox")).toBeNull()
	})

	it("edits the typed text only and resends the tags verbatim", async () => {
		render(<UserMessage messageReferences={[REF]} messageTs={5} text="use this" />)
		fireEvent.click(screen.getByRole("button", { name: "Edit and regenerate from this message" }))

		const box = screen.getByRole("textbox") as HTMLTextAreaElement
		expect(box.value).toBe("use this")
		expect(screen.getByTestId("message-tag-source")).toHaveTextContent("You · Dev plan")
		fireEvent.change(box, { target: { value: "use that" } })
		fireEvent.click(screen.getByRole("button", { name: "Reset Chat" }))

		await waitFor(() => expect(editMessageAndRegenerate).toHaveBeenCalled())
		const request = editMessageAndRegenerate.mock.calls[0][0]
		expect(request.text).toBe("use that")
		expect(request.provenance.messageLinks).toEqual([
			expect.objectContaining({
				threadId: "7_src",
				threadTitle: "Dev plan",
				author: "user",
				text: "Cap exports at 10k rows",
			}),
		])
		// The tags were never put into the editable text, and they don't authorize any thread.
		expect(request.provenance.authorizedThreadIds ?? []).toEqual([])
	})

	it("drops a tag the user removes while editing", async () => {
		render(<UserMessage messageReferences={[REF, REF_2]} messageTs={5} text="use these" />)
		fireEvent.click(screen.getByRole("button", { name: "Edit and regenerate from this message" }))
		fireEvent.click(screen.getAllByRole("button", { name: "Remove message" })[0])
		fireEvent.click(screen.getByRole("button", { name: "Reset Chat" }))

		await waitFor(() => expect(editMessageAndRegenerate).toHaveBeenCalled())
		expect(editMessageAndRegenerate.mock.calls[0][0].provenance.messageLinks).toEqual([
			expect.objectContaining({ threadId: "8_src", text: "Use the queue." }),
		])
	})

	it("sends no provenance for a message without tags", async () => {
		render(<UserMessage messageTs={5} text="plain" />)
		fireEvent.click(screen.getByRole("button", { name: "Edit and regenerate from this message" }))
		fireEvent.click(screen.getByRole("button", { name: "Reset Chat" }))
		await waitFor(() => expect(editMessageAndRegenerate).toHaveBeenCalled())
		expect(editMessageAndRegenerate.mock.calls[0][0].provenance).toBeUndefined()
	})
})
