import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DocEditor } from "./DocEditor"

vi.mock("@/utils/platformUtils", () => ({ getCurrentPlatform: () => "mac", modKeyLabel: () => "⌘" }))

describe("DocEditor", () => {
	it("previews the rendered page and switches to a text box with a format bar", () => {
		render(<DocEditor label="Note body" onSave={vi.fn()} value="**bold**" />)
		expect(screen.getByTestId("doc-editor-preview").querySelector("strong")).toHaveTextContent("bold")
		expect(screen.queryByRole("toolbar")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("radio", { name: "Edit" }))
		expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("**bold**")
		expect(screen.getByRole("toolbar", { name: "Format" })).toBeInTheDocument()
	})

	it("saves with ⌘S and keeps an unsaved draft when Esc goes back to Preview", async () => {
		const onSave = vi.fn()
		render(<DocEditor initialMode="edit" label="Note body" onSave={onSave} value="old" />)
		const box = screen.getByRole("textbox", { name: "Note body" })
		fireEvent.change(box, { target: { value: "new" } })
		fireEvent.keyDown(box, { key: "Escape" })
		expect(screen.getByText("Unsaved draft")).toBeInTheDocument()
		expect(screen.getByTestId("doc-editor-preview")).toHaveTextContent("new")
		fireEvent.click(screen.getByRole("radio", { name: "Edit" }))
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Note body" }), { key: "s", metaKey: true })
		await waitFor(() => expect(onSave).toHaveBeenCalledWith("new"))
		expect(await screen.findByText("Saved")).toBeInTheDocument()
	})

	it("formats the selection from the bar", () => {
		render(<DocEditor initialMode="edit" label="Note body" onSave={vi.fn()} value="word" />)
		const box = screen.getByRole("textbox", { name: "Note body" }) as HTMLTextAreaElement
		box.setSelectionRange(0, 4)
		fireEvent.click(screen.getByRole("button", { name: "Bold" }))
		expect(box).toHaveValue("**word**")
	})

	it("keeps the draft and says why when saving fails or is blocked", async () => {
		const onSave = vi.fn().mockRejectedValue(new Error("changed on disk"))
		const { rerender } = render(<DocEditor initialMode="edit" label="Note body" onSave={onSave} value="a" />)
		fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "b" } })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("changed on disk")
		expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("b")
		rerender(<DocEditor blockedReason="Over the cap." initialMode="edit" label="Note body" onSave={onSave} value="a" />)
		expect(screen.getByText("Over the cap.")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
	})

	it("shows read-only docs without the switch, saying why", () => {
		render(<DocEditor label="Rule body" onSave={vi.fn()} readOnlyReason="Fix the front matter first." value="x" />)
		expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument()
		expect(screen.getByText("Fix the front matter first.")).toBeInTheDocument()
	})
})
