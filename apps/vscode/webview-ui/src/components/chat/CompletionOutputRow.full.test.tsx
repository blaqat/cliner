import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CompletionOutputRow } from "./CompletionOutputRow"

vi.mock("@/services/grpc-client", () => ({
	CheckpointsServiceClient: {},
	FileServiceClient: {},
	StateServiceClient: {},
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ mode: "act" }) }))

describe("CompletionOutputRow with a long answer", () => {
	it("renders the whole final answer with no section pager", () => {
		const text = Array.from({ length: 1_000 }, (_, i) => `Finding number ${i} ${"detail ".repeat(10)}`).join("\n\n")
		expect(text.length).toBeGreaterThan(16 * 1024)
		const { container } = render(
			<CompletionOutputRow
				handleQuoteClick={vi.fn()}
				quoteButtonState={{ visible: false, top: 0, left: 0, selectedText: "" }}
				text={text}
			/>,
		)
		expect(container.textContent).toContain("Finding number 0 ")
		expect(container.textContent).toContain("Finding number 999 ")
		expect(screen.queryByText(/Large content/)).toBeNull()
		expect(screen.queryByRole("button", { name: /section/i })).toBeNull()
	})
})
