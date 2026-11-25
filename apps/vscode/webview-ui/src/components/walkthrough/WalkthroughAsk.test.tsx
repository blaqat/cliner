import type { WalkthroughAskThread } from "@shared/Walkthrough"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { askSideThreadPrompt, type DiffAsk, WalkthroughAsk } from "./WalkthroughAsk"

const range = { start: 1, end: 2, quote: "if (!value) return" }
const thread: WalkthroughAskThread = {
	id: "ask-1",
	hunkId: "h1",
	line: 1,
	endLine: 2,
	turns: [{ question: "Why?", answer: "Reject empty input.", pick: { modelId: "model", levelId: "high" }, context: "thread" }],
}
const props = (): DiffAsk => ({
	config: { pick: { modelId: "model", levelId: "high" }, label: "Model · High", context: "thread" },
	threads: [],
	ask: vi.fn().mockResolvedValue(undefined),
	addToSend: vi.fn(),
	isAdded: () => false,
	openSettings: vi.fn(),
	onOpen: vi.fn(),
})

describe("walkthrough Ask", () => {
	it("shows a quiet model/context line with no controls and does not make a call on open or starter", () => {
		const ask = props()
		render(<WalkthroughAsk ask={ask} range={range} />)
		expect(screen.getByTestId("walkthrough-ask-uses")).toHaveTextContent("Model · High · This thread")
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
		fireEvent.click(screen.getByText("Why this approach?"))
		expect(ask.ask).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "Ask" })).toHaveAttribute(
			"title",
			expect.stringContaining("Starts a model call"),
		)
	})
	it("shows loading until the user-started request finishes, then closes the new form", async () => {
		let finish!: () => void
		const ask = props()
		ask.ask = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const onClose = vi.fn()
		render(<WalkthroughAsk ask={ask} onClose={onClose} range={range} />)
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Why reject this?" } })
		fireEvent.click(screen.getByRole("button", { name: "Ask" }))
		expect(ask.ask).toHaveBeenCalledWith(range, "Why reject this?", undefined)
		expect(screen.getByRole("button", { name: "Asking…" })).toBeDisabled()
		expect(screen.getByText("Waiting for the model…")).toBeInTheDocument()
		await act(async () => finish())
		expect(onClose).toHaveBeenCalledOnce()
	})
	it("shows answers with a follow-up and adds nothing to Send without a click", async () => {
		const ask = props()
		render(<WalkthroughAsk ask={ask} range={range} thread={thread} />)
		expect(screen.getByText("Reject empty input.")).toBeInTheDocument()
		expect(screen.getByRole("textbox", { name: "Follow-up question" })).toBeInTheDocument()
		expect(ask.addToSend).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Add to Send" }))
		expect(ask.addToSend).toHaveBeenCalledWith(thread)
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "What about whitespace?" } })
		fireEvent.click(screen.getByRole("button", { name: "Ask follow-up" }))
		await waitFor(() => expect(ask.ask).toHaveBeenCalledWith(range, "What about whitespace?", "ask-1"))
	})
	it("explains missing models with a Settings link, keeping the question editable", () => {
		const ask = props()
		ask.config!.unavailable = "Connection credentials are missing."
		render(<WalkthroughAsk ask={ask} range={range} />)
		expect(screen.getByRole("alert")).toHaveTextContent("Connection credentials are missing.")
		fireEvent.click(screen.getByRole("button", { name: "Open Settings" }))
		expect(ask.openSettings).toHaveBeenCalledOnce()
		expect(screen.getByRole("textbox")).toBeEnabled()
		expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
	})
	it("keeps the question and saved answers after failure and offers an explicit retry", async () => {
		const ask = props()
		vi.mocked(ask.ask).mockRejectedValueOnce(new Error("Provider is unavailable."))
		render(<WalkthroughAsk ask={ask} range={range} thread={thread} />)
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Why now?" } })
		fireEvent.click(screen.getByRole("button", { name: "Ask follow-up" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("Provider is unavailable.")
		expect(screen.getByRole("textbox")).toHaveValue("Why now?")
		expect(screen.getByText("Reject empty input.")).toBeInTheDocument()
		expect(ask.ask).toHaveBeenCalledOnce()
		fireEvent.click(screen.getByRole("button", { name: "Ask follow-up" }))
		await waitFor(() => expect(ask.ask).toHaveBeenCalledTimes(2))
	})
	it("asks with Ctrl/⌘+Enter, closes with Esc, and says why it failed", async () => {
		const ask = props()
		vi.mocked(ask.ask).mockRejectedValueOnce(new Error("Rate limited."))
		const onClose = vi.fn()
		render(<WalkthroughAsk ask={ask} onClose={onClose} range={range} />)
		const box = screen.getByRole("textbox")
		expect(box).toHaveFocus()
		fireEvent.change(box, { target: { value: "Why?" } })
		fireEvent.keyDown(box, { key: "Enter", ctrlKey: true })
		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't get an answer: Rate limited.")
		fireEvent.keyDown(box, { key: "Escape" })
		expect(onClose).toHaveBeenCalledOnce()
	})
	it("opens an answer as a side thread only on request", async () => {
		const ask = props()
		ask.openAsSideThread = vi.fn().mockResolvedValue(undefined)
		render(<WalkthroughAsk ask={ask} range={range} thread={thread} />)
		expect(ask.openAsSideThread).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Open as side thread" }))
		await waitFor(() => expect(ask.openAsSideThread).toHaveBeenCalledWith(thread))
	})
	it("builds the side thread's first message from the question and answer", () => {
		expect(askSideThreadPrompt("src/a.ts", { ...thread, quote: "if (!value) return" })).toBe(
			"From the walkthrough, about src/a.ts:\n\n```\nif (!value) return\n```\n\nQuestion: Why?\nAnswer: Reject empty input.\n\nLet's keep talking about this here.",
		)
	})
	it("puts Cline's note at the top of a side thread opened from an answer about it", () => {
		const reviewNote = {
			id: "r1",
			kind: "risk" as const,
			severity: "high" as const,
			title: "Empty input",
			text: "Rejects ``.",
		}
		expect(askSideThreadPrompt("src/a.ts", { ...thread, reviewNote })).toBe(
			"From the walkthrough, about src/a.ts:\n\nAbout Cline's review note · Risk (high): Empty input\nRejects ``.\n\nQuestion: Why?\nAnswer: Reject empty input.\n\nLet's keep talking about this here.",
		)
	})
	it("asks a question it opens with right away, and calls back once answered", async () => {
		const ask = props()
		const onAsked = vi.fn()
		render(
			<WalkthroughAsk ask={ask} initial={{ question: "Is this awaited?", submit: true }} onAsked={onAsked} range={range} />,
		)
		await waitFor(() => expect(onAsked).toHaveBeenCalledOnce())
		expect(ask.ask).toHaveBeenCalledOnce()
		expect(ask.ask).toHaveBeenCalledWith(range, "Is this awaited?", undefined)
	})
	it("selects a starter question so typing replaces it, without asking", () => {
		const ask = props()
		render(<WalkthroughAsk ask={ask} initial={{ question: "Why is this a problem?" }} range={range} />)
		const box = screen.getByRole("textbox") as HTMLTextAreaElement
		expect(box.selectionStart).toBe(0)
		expect(box.selectionEnd).toBe("Why is this a problem?".length)
		expect(ask.ask).not.toHaveBeenCalled()
	})
})
