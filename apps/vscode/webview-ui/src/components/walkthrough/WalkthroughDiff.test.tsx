import type { WalkthroughHunk } from "@shared/Walkthrough"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { diffLanguage, highlightDiff } from "./diffHighlight"
import { WalkthroughDiff } from "./WalkthroughDiff"

afterEach(cleanup)

describe("diffLanguage", () => {
	it.each([
		["Main.java", "java"],
		["src/main.ts", "typescript"],
		["App.tsx", "typescript"],
		["main.js", "javascript"],
		["App.jsx", "javascript"],
		["main.py", "python"],
		["main.go", "go"],
		["main.rs", "rust"],
		["Main.kt", "kotlin"],
		["App.swift", "swift"],
		["main.c", "c"],
		["main.cpp", "cpp"],
		["Main.cs", "csharp"],
		["app.rb", "ruby"],
		["index.php", "php"],
		["run.sh", "bash"],
		["data.json", "json"],
		["config.yaml", "yaml"],
		["config.yml", "yaml"],
		["README.md", "markdown"],
		["style.css", "css"],
		["index.html", "xml"],
		["query.sql", "sql"],
		["C:\\src\\Main.JAVA", "java"],
		["README", "plaintext"],
		["file.unknown", "plaintext"],
		[".java", "plaintext"],
		["folder.java/README", "plaintext"],
	])("maps %s to %s", (path, language) => {
		expect(diffLanguage(path)).toBe(language)
	})
})

const javaHunk: WalkthroughHunk = {
	id: "java",
	fingerprint: "fp",
	fileId: "main",
	path: "src/Main.java",
	header: "@@ -1,4 +1,4 @@",
	oldStart: 1,
	newStart: 1,
	patch: '@@ -1,4 +1,4 @@\n public class Main {\n-  String value = "old";\n+  String value = "new";\n   /* a comment\n      continues */\n',
}

describe("walkthrough diff highlighting", () => {
	it("renders Java tokens, line backgrounds, annotations and note anchors", () => {
		const onEdit = vi.fn()
		const { container } = render(
			<WalkthroughDiff
				annotations={[{ hunkId: "java", line: 2, kind: "why", text: "Updated value" }]}
				hunk={javaHunk}
				notes={{ list: [], set: vi.fn(), onEdit }}
			/>,
		)
		const rows = screen.getAllByTestId("walkthrough-diff-line")
		expect(rows[0].querySelector(".hljs-keyword")?.textContent).toBe("public")
		expect(rows[1].querySelector(".hljs-string")?.textContent).toBe('"old"')
		expect(rows[2].querySelector(".hljs-string")?.textContent).toBe('"new"')
		expect(rows[1].getAttribute("style")).toContain("--vscode-diffEditor-removedTextBackground")
		expect(rows[2].getAttribute("style")).toContain("--vscode-diffEditor-insertedTextBackground")
		expect(rows[4].querySelector(".hljs-comment")?.textContent).toBe("     continues */")
		expect(screen.getByTestId("walkthrough-annotation").textContent).toContain("Updated value")
		fireEvent.click(rows[2].querySelector("button")!)
		expect(onEdit).toHaveBeenCalledWith({ start: 2, end: 2 })
		expect(container.textContent).not.toContain("<span")
	})

	it("keeps multiline comment state separate for removed and added sides", () => {
		const tokens = highlightDiff(["-/* removed comment", '+String value = "new";', "- ends here */"], "Main.java")
		const { container } = render(
			<div>
				{tokens?.map((line, index) => (
					<div key={index}>{line}</div>
				))}
			</div>,
		)
		expect(container.children[0].children[0].querySelector(".hljs-comment")).not.toBeNull()
		expect(container.children[0].children[1].querySelector(".hljs-string")?.textContent).toBe('"new"')
		expect(container.children[0].children[2].querySelector(".hljs-comment")?.textContent).toBe(" ends here */")
	})

	it("preserves plain text, CRLF, whitespace and literal markup", () => {
		const body = ['+  String html = "<script>&";\r', "+"]
		const { container } = render(
			<div>
				{highlightDiff(body, "Main.java")?.map((line, index) => (
					<div key={index}>{line}</div>
				))}
			</div>,
		)
		expect(container.textContent).toBe('  String html = "<script>&";')
		expect(container.querySelector("script")).toBeNull()
		expect(highlightDiff(body, "README")).toBeUndefined()
		expect(highlightDiff(body, "file.unknown")).toBeUndefined()
	})

	it("skips large hunks by line and character counts", () => {
		expect(highlightDiff(Array(2001).fill("+public class Main {}"), "Main.java")).toBeUndefined()
		expect(highlightDiff([`+${"a".repeat(128 * 1024)}`], "Main.java")).toBeUndefined()
	})
})
