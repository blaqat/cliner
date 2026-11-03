import type { ReactNode } from "react"
import rehypeHighlight from "rehype-highlight"
import { unified } from "unified"

const LANGUAGES: Record<string, string> = {
	java: "java",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	pyw: "python",
	go: "go",
	rs: "rust",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	hxx: "cpp",
	cs: "csharp",
	rb: "ruby",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	json: "json",
	jsonc: "json",
	yaml: "yaml",
	yml: "yaml",
	md: "markdown",
	markdown: "markdown",
	css: "css",
	scss: "scss",
	less: "less",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	sql: "sql",
	lua: "lua",
	pl: "perl",
	r: "r",
	graphql: "graphql",
	gql: "graphql",
}

export function diffLanguage(path: string): string {
	const filename = path.split(/[\\/]/).pop() ?? ""
	const dot = filename.lastIndexOf(".")
	const extension = filename.slice(dot + 1).toLowerCase()
	return dot > 0 && Object.hasOwn(LANGUAGES, extension) ? LANGUAGES[extension] : "plaintext"
}

const processor = unified().use(rehypeHighlight)
type Root = Parameters<ReturnType<typeof rehypeHighlight>>[0]
type Element = Extract<Root["children"][number], { type: "element" }>

/** Highlight a complete side, then split tokens at newlines without losing their classes. */
function highlightSide(lines: string[], language: string): ReactNode[][] {
	const code: Element = {
		type: "element",
		tagName: "code",
		properties: { className: [`language-${language}`] },
		children: [{ type: "text", value: lines.join("\n") }],
	}
	const tree: Root = {
		type: "root",
		children: [{ type: "element", tagName: "pre", properties: {}, children: [code] }],
	}
	processor.runSync(tree)
	const result: ReactNode[][] = [[]]
	const visit = (node: Element["children"][number], classes: string[]) => {
		if (node.type === "text") {
			for (const [index, part] of node.value.split("\n").entries()) {
				if (index) result.push([])
				if (!part) continue
				const line = result[result.length - 1]
				line.push(
					classes.reduceRight<ReactNode>(
						(child, className) => (
							<span className={className} key={line.length}>
								{child}
							</span>
						),
						part,
					),
				)
			}
		} else if (node.type === "element") {
			const ownClasses = node.properties.className
			const nested = Array.isArray(ownClasses) ? [...classes, ownClasses.join(" ")] : classes
			for (const child of node.children) visit(child, nested)
		}
	}
	for (const node of code.children) visit(node, [])
	return result
}

export const diffCode = (line: string) => line.slice(1).replace(/\r$/, "")

/** Returns no tokens for unknown languages or large hunks; callers retain the full plain text. */
export function highlightDiff(body: string[], path: string): ReactNode[][] | undefined {
	const language = diffLanguage(path)
	if (language === "plaintext" || body.length > 2000 || body.reduce((size, line) => size + line.length, 0) > 128 * 1024) {
		return undefined
	}
	try {
		const oldLines = body.filter((line) => !line.startsWith("+")).map(diffCode)
		const newLines = body.filter((line) => !line.startsWith("-")).map(diffCode)
		const oldTokens = highlightSide(oldLines, language)
		const newTokens = highlightSide(newLines, language)
		let oldIndex = 0
		let newIndex = 0
		return body.map((line) => {
			if (line.startsWith("-")) return oldTokens[oldIndex++]
			if (line.startsWith("+")) return newTokens[newIndex++]
			oldIndex++
			return newTokens[newIndex++]
		})
	} catch {
		return undefined
	}
}
