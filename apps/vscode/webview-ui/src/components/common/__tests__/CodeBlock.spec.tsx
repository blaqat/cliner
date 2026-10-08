import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import CodeBlock from "../CodeBlock"
import { TEXT_PREVIEW_CHARACTERS } from "../text-preview"

describe("CodeBlock", () => {
	it("renders highlighted code on the first render, so the row keeps its height when re-mounted", () => {
		const { container } = render(<CodeBlock source={"```ts\nconst answer = 42\n```"} />)
		const code = container.querySelector("pre code")
		expect(code?.textContent).toContain("const answer = 42")
		expect(code?.querySelector(".hljs-keyword")).not.toBeNull()
	})

	it("uses a file name's extension as the language", () => {
		const { container } = render(<CodeBlock source={"```src/index.py\ndef f(): pass\n```"} />)
		expect(container.querySelector("code.language-py, code.language-python")).not.toBeNull()
	})

	it("renders a diff and plain output without a language", () => {
		const { container } = render(<CodeBlock source={"```\nplain output\n```"} />)
		expect(container.textContent).toContain("plain output")
	})

	it.each([
		"```ts\n" + Array.from({ length: 20_000 }, (_, i) => `const value_${i} = "${"x".repeat(80)}";`).join("\n") + "\n```",
		"```diff\n+" + "x".repeat(2 * 1024 * 1024) + "\n```",
	])("bounds huge blocks before parsing or highlighting", (source) => {
		const { container, rerender } = render(<CodeBlock forceWrap source={source} />)
		const pre = container.querySelector("pre")!
		expect(pre.textContent!.length).toBeLessThanOrEqual(TEXT_PREVIEW_CHARACTERS)
		expect(container.querySelector(".hljs")).toBeNull()
		expect(container.querySelectorAll("*").length).toBeLessThan(100)
		rerender(<CodeBlock forceWrap source={source + "tail"} />)
		expect(container.querySelector("pre")).toBe(pre)
	})

	it("pages through full content without accumulating DOM and copies the unabridged source", async () => {
		const source = "a".repeat(TEXT_PREVIEW_CHARACTERS) + "last section"
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
		const { container } = render(<CodeBlock source={source} />)
		fireEvent.click(screen.getByRole("button", { name: "Show next section" }))
		expect(container.querySelector("pre")!.textContent).toBe("last section")
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy full content" }))
		})
		expect(writeText).toHaveBeenCalledWith(source)
		fireEvent.click(screen.getByRole("button", { name: "Previous section" }))
		expect(container.querySelector("pre")!.textContent).toBe("a".repeat(TEXT_PREVIEW_CHARACTERS))
	})
})
