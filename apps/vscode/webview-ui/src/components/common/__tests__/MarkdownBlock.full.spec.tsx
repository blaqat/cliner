import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import MarkdownBlock from "../MarkdownBlock"

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: {}, StateServiceClient: {} }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ mode: "act" }) }))

describe("large chat markdown", () => {
	it("renders the full content with no pager", () => {
		const source = Array.from({ length: 1_000 }, (_, i) => `Paragraph number ${i} ${"word ".repeat(10)}`).join("\n\n")
		expect(source.length).toBeGreaterThan(16 * 1024)
		const { container } = render(<MarkdownBlock markdown={source} />)
		expect(container.textContent).toContain("Paragraph number 0 ")
		expect(container.textContent).toContain("Paragraph number 999 ")
		expect(container.textContent).not.toContain("Large content")
		expect(screen.queryByRole("button", { name: /section/i })).toBeNull()
	})
})
