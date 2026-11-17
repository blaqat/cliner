import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { QuoteDraft } from "./chat-view/types/chatTypes"
import { QuoteTagList } from "./QuoteTag"

const LONG_TEXT = "The quick brown fox jumps over the lazy dog and keeps running across the whole field of text."

function Harness({ initial, onChange }: { initial: QuoteDraft[]; onChange?: (quotes: QuoteDraft[]) => void }) {
	const [quotes, setQuotes] = useState(initial)
	return (
		<>
			<QuoteTagList
				focusComposer={() => document.getElementById("composer")?.focus()}
				quotes={quotes}
				setQuotes={(update) =>
					setQuotes((current) => {
						const next = typeof update === "function" ? update(current) : update
						onChange?.(next)
						return next
					})
				}
			/>
			<textarea aria-label="composer" id="composer" />
		</>
	)
}

const chip = (index = 0) => within(screen.getAllByTestId("quote-tag")[index]).getAllByRole("button")[0]

describe("QuoteTagList", () => {
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

	it("renders a compact tag with an icon, a truncated excerpt and a note indicator", () => {
		render(
			<Harness
				initial={[
					{ text: LONG_TEXT, note: "" },
					{ text: "second\n  passage", note: "why?" },
				]}
			/>,
		)

		const tags = screen.getAllByTestId("quote-tag")
		expect(tags).toHaveLength(2)
		expect(tags[0]).toHaveClass("max-w-[200px]")
		const excerpts = screen.getAllByTestId("quote-tag-excerpt")
		expect(excerpts[0]).toHaveClass("truncate")
		expect(excerpts[1]).toHaveTextContent(/^second passage$/)
		expect(within(tags[0]).queryByTestId("quote-tag-note-indicator")).toBeNull()
		expect(within(tags[1]).getByTestId("quote-tag-note-indicator")).toBeInTheDocument()
		expect(screen.getByTestId("quote-tag-list")).toHaveClass("overflow-x-auto")
	})

	it("shows the full text and note in a tooltip on hover", async () => {
		render(<Harness initial={[{ text: LONG_TEXT, note: "check this" }]} />)

		fireEvent.mouseEnter(chip())

		const tooltip = (await screen.findAllByTestId("quote-tag-tooltip"))[0]
		expect(tooltip).toHaveTextContent(LONG_TEXT)
		expect(tooltip).toHaveTextContent("Note: check this")
		fireEvent.mouseLeave(chip())
		expect(screen.queryByTestId("quote-tag-tooltip")).toBeNull()
	})

	it("opens the note editor on click and updates the note", async () => {
		const onChange = vi.fn()
		render(<Harness initial={[{ text: "first passage", note: "" }]} onChange={onChange} />)

		fireEvent.click(chip())

		const editor = await screen.findByTestId("quote-tag-editor")
		const note = within(editor).getByLabelText("Note on this quote")
		fireEvent.change(note, { target: { value: "explain" } })
		expect(onChange).toHaveBeenLastCalledWith([{ text: "first passage", note: "explain" }])

		fireEvent.keyDown(note, { key: "Enter" })
		await act(async () => {})
		expect(screen.queryByTestId("quote-tag-editor")).toBeNull()
	})

	it("removes a quote from the tag x and from the editor", async () => {
		const onChange = vi.fn()
		render(
			<Harness
				initial={[
					{ text: "first passage", note: "" },
					{ text: "second passage", note: "" },
				]}
				onChange={onChange}
			/>,
		)

		fireEvent.click(screen.getAllByRole("button", { name: "Remove quote" })[0])
		expect(onChange).toHaveBeenLastCalledWith([{ text: "second passage", note: "" }])

		fireEvent.click(chip())
		fireEvent.click(within(await screen.findByTestId("quote-tag-editor")).getByLabelText("Dismiss quote"))
		expect(onChange).toHaveBeenLastCalledWith([])
	})

	it("is keyboard accessible: Enter edits, Backspace/Delete removes and keeps focus nearby", async () => {
		const onChange = vi.fn()
		render(
			<Harness
				initial={[
					{ text: "first passage", note: "" },
					{ text: "second passage", note: "" },
				]}
				onChange={onChange}
			/>,
		)

		chip(0).focus()
		expect(chip(0)).toHaveFocus()
		fireEvent.keyDown(chip(0), { key: "Enter" })
		expect(await screen.findByTestId("quote-tag-editor")).toBeInTheDocument()
		fireEvent.keyDown(within(screen.getByTestId("quote-tag-editor")).getByLabelText("Note on this quote"), {
			key: "Escape",
		})
		await waitFor(() => expect(screen.getByLabelText("composer")).toHaveFocus())
		expect(screen.queryByTestId("quote-tag-editor")).toBeNull()

		chip(0).focus()
		fireEvent.keyDown(chip(0), { key: "Backspace" })
		expect(onChange).toHaveBeenLastCalledWith([{ text: "second passage", note: "" }])
		await act(async () => {})
		expect(screen.getByRole("button", { name: /^Quote: second passage/ })).toHaveFocus()

		fireEvent.keyDown(screen.getByRole("button", { name: /^Quote: second passage/ }), { key: "Delete" })
		expect(onChange).toHaveBeenLastCalledWith([])
		await act(async () => {})
		expect(screen.getByLabelText("composer")).toHaveFocus()
	})

	it("opens the editor for a just-added quote", async () => {
		render(
			<QuoteTagList autoOpenIndex={0} focusComposer={vi.fn()} quotes={[{ text: "new", note: "" }]} setQuotes={vi.fn()} />,
		)
		expect(await screen.findByTestId("quote-tag-editor")).toBeInTheDocument()
	})
})
