import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/services/grpc-client"
import { TEXT_PREVIEW_CHARACTERS } from "../common/text-preview"
import { DiffEditRow } from "./DiffEditRow"

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { openFileRelativePath: vi.fn().mockResolvedValue({}) } }))

describe("large diff previews", () => {
	it.each([
		Array.from({ length: 5_000 }, (_, i) => `@@\n-old ${i}\n+new ${i}`).join("\n"),
		"+" + "x".repeat(2 * 1024 * 1024),
		Array.from({ length: 20_000 }, (_, i) => `+line ${i}`).join("\n"),
	])("bounds parsing and rendered nodes for huge patches", (body) => {
		const patch = `*** Begin Patch\n*** Update File: large.ts\n${body}\n*** End Patch`
		const { container, rerender } = render(<DiffEditRow isLoading patch={patch} path="large.ts" />)
		expect(container.querySelectorAll("*").length).toBeLessThan(2_000)
		expect(container.textContent!.length).toBeLessThan(TEXT_PREVIEW_CHARACTERS + 5_000)
		expect(screen.getByText(/Showing a partial preview/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Open in editor" }))
		expect(FileServiceClient.openFileRelativePath).toHaveBeenCalledWith(expect.objectContaining({ value: "large.ts" }))
		const firstLine = container.querySelector(".font-mono .flex.text-xs")
		rerender(<DiffEditRow isLoading patch={patch + "more streamed text"} path="large.ts" />)
		expect(container.querySelector(".font-mono .flex.text-xs")).toBe(firstLine)
	})

	it("keeps small edits and their full diff counts", () => {
		const { container } = render(<DiffEditRow patch="------- SEARCH\nold\n=======\nnew\n+++++++ REPLACE" path="small.ts" />)
		expect(container.textContent).toContain("old")
		expect(container.textContent).toContain("new")
		expect(screen.queryByText(/Showing a partial preview/)).toBeNull()
	})
})
