import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MessageTagDraft } from "./chat-view/types/chatTypes"
import { MessageTagList } from "./MessageTag"

const LONG_TEXT = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the linked message.`).join("\n")

const TAG: MessageTagDraft = { threadId: "t1", messageIndex: 2, text: LONG_TEXT, source: "You · Dev plan" }

function Harness({ initial, onChange }: { initial: MessageTagDraft[]; onChange?: (tags: MessageTagDraft[]) => void }) {
	const [tags, setTags] = useState(initial)
	return (
		<>
			<MessageTagList
				focusComposer={() => document.getElementById("composer")?.focus()}
				setTags={(update) =>
					setTags((current) => {
						const next = typeof update === "function" ? update(current) : update
						onChange?.(next)
						return next
					})
				}
				tags={tags}
			/>
			<textarea aria-label="composer" id="composer" />
		</>
	)
}

describe("MessageTagList", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("renders a compact chip with the source and no note field", () => {
		render(<Harness initial={[TAG, { ...TAG, messageIndex: 3, source: "Cline · Dev plan" }]} />)
		const chips = screen.getAllByTestId("message-tag")
		expect(chips).toHaveLength(2)
		expect(screen.getAllByTestId("message-tag-source").map((el) => el.textContent)).toEqual([
			"You · Dev plan",
			"Cline · Dev plan",
		])
		// Not a quote: no note indicator, no editor, no excerpt of the message on the chip itself.
		expect(screen.queryByTestId("quote-tag")).toBeNull()
		expect(screen.queryByTestId("quote-tag-editor")).toBeNull()
		expect(chips[0]).not.toHaveTextContent("Line 1")
	})

	it("shows the linked message in a height-capped, scrollable card on hover", async () => {
		render(<Harness initial={[TAG]} />)
		expect(screen.queryByTestId("message-tag-text")).toBeNull()

		fireEvent.pointerEnter(screen.getByRole("button", { name: /^Message from You · Dev plan/ }))

		const text = await screen.findByTestId("message-tag-text")
		expect(text).toHaveTextContent("Line 1 of the linked message.")
		expect(text).toHaveTextContent("Line 80 of the linked message.")
		expect(text.className).toContain("max-h-48")
		expect(text.className).toContain("overflow-y-auto")
		expect(screen.getByTestId("message-tag-card")).toHaveTextContent("You · Dev plan")
	})

	it("shows the card on keyboard focus too", async () => {
		render(<Harness initial={[TAG]} />)
		screen.getByRole("button", { name: /^Message from/ }).focus()
		await waitFor(() => expect(screen.getByTestId("message-tag-text")).toBeInTheDocument())
	})

	it("removes a chip with its x button and returns focus to the composer", () => {
		const onChange = vi.fn()
		render(<Harness initial={[TAG, { ...TAG, messageIndex: 3 }]} onChange={onChange} />)
		fireEvent.click(screen.getAllByRole("button", { name: "Remove message" })[0])
		expect(onChange).toHaveBeenLastCalledWith([{ ...TAG, messageIndex: 3 }])
		expect(screen.getAllByTestId("message-tag")).toHaveLength(1)
		expect(document.activeElement).toBe(screen.getByLabelText("composer"))
	})

	it("removes a focused chip with Backspace or Delete", () => {
		const onChange = vi.fn()
		render(<Harness initial={[TAG]} onChange={onChange} />)
		fireEvent.keyDown(screen.getByRole("button", { name: /^Message from/ }), { key: "Backspace" })
		expect(onChange).toHaveBeenLastCalledWith([])
		expect(screen.queryByTestId("message-tag")).toBeNull()
	})
})
