import { render } from "@testing-library/react"
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
})
