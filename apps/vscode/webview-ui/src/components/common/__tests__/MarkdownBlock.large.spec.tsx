import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import MarkdownBlock from "../MarkdownBlock"
import { TEXT_PREVIEW_CHARACTERS } from "../text-preview"

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: {}, StateServiceClient: {} }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ mode: "act" }) }))
vi.mock("@/components/common/MermaidBlock", () => ({
	default: () => {
		throw new Error("Oversized diagrams must not render")
	},
}))

describe("large chat markdown", () => {
	it("bounds markdown before lexing, diagram layout, or highlighting and retains later sections", () => {
		const source = "```mermaid\n" + "graph TD; A --> B;\n".repeat(20_000) + "```\nend"
		const { container } = render(<MarkdownBlock markdown={source} />)
		expect(container.querySelector("pre")!.textContent!.length).toBeLessThanOrEqual(TEXT_PREVIEW_CHARACTERS)
		expect(container.querySelectorAll("*").length).toBeLessThan(100)
		fireEvent.click(screen.getByRole("button", { name: "Show next section" }))
		expect(container.querySelector("pre")!.textContent!.length).toBeLessThanOrEqual(TEXT_PREVIEW_CHARACTERS)
	})
})
