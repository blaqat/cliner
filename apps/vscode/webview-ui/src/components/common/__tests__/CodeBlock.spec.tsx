import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import CodeBlock from "../CodeBlock"

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

	it("renders large blocks in full with no pager", () => {
		const lines = Array.from({ length: 1_000 }, (_, i) => `const value_${i} = "${"x".repeat(40)}";`)
		const { container } = render(<CodeBlock source={"```ts\n" + lines.join("\n") + "\n```"} />)
		expect(container.textContent).toContain("value_999")
		expect(container.textContent).not.toContain("Large content")
		expect(screen.queryByRole("button", { name: /section/i })).toBeNull()
	})

	it("shows an oversized block in full without highlighting it", () => {
		const body = "x".repeat(200 * 1024)
		const { container } = render(<CodeBlock source={"```shell\n" + body + "\n```"} />)
		expect(container.textContent).toBe(body)
		expect(container.querySelector(".hljs")).toBeNull()
	})
})
