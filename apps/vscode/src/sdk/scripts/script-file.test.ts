import { describe, expect, it } from "vitest"
import { parseScriptFile, scriptTemplate, setScriptApprovalInContent } from "./script-file"

const file = (content: string, fallbackName = "test-module") =>
	parseScriptFile(content, { filePath: `/tmp/scripts/${fallbackName}.md`, scope: "workspace", fallbackName })

const VALID = `---
name: test-module
description: Run one module's tests
command: bun run test --filter {{module}}{{#filter}} -t {{filter}}{{/filter}}{{#watch}} --watch{{/watch}}
cwd: packages
approval: always_allow
options:
  - name: module
    kind: choice
    required: true
    description: Module to test
    choices: [api, web]
    default: api
  - name: filter
    kind: text
    description: Test name pattern
  - name: watch
    kind: flag
    description: Re-run on change
    default: false
---

# Notes

Run it after changing a module.
`

describe("parseScriptFile", () => {
	it("reads every frontmatter field and the notes body", () => {
		const parsed = file(VALID)
		expect(parsed.errors).toEqual([])
		expect(parsed.script).toMatchObject({
			name: "test-module",
			description: "Run one module's tests",
			cwd: "packages",
			approval: "always_allow",
			scope: "workspace",
			notes: "# Notes\n\nRun it after changing a module.",
		})
		expect(parsed.script?.options).toEqual([
			{
				name: "module",
				kind: "choice",
				required: true,
				description: "Module to test",
				choices: ["api", "web"],
				default: "api",
			},
			{ name: "filter", kind: "text", required: false, description: "Test name pattern" },
			{ name: "watch", kind: "flag", required: false, description: "Re-run on change", default: false },
		])
	})

	it("defaults approval to ask in Ask mode and the name to the file name", () => {
		const parsed = file("---\ndescription: d\ncommand: echo hi\n---\n", "hello")
		expect(parsed.script?.name).toBe("hello")
		expect(parsed.script?.approval).toBe("ask_in_ask_mode")
		expect(parsed.script?.options).toEqual([])
	})

	it("accepts choicesFrom: mmrc without listed choices", () => {
		const parsed = file(
			"---\ndescription: d\ncommand: mm {{mod}}\noptions:\n  - name: mod\n    kind: choice\n    choicesFrom: mmrc\n---\n",
		)
		expect(parsed.errors).toEqual([])
		expect(parsed.script?.options[0].choicesFrom).toBe("mmrc")
	})

	it("rejects a file without frontmatter or with broken YAML, keeping a name for the list", () => {
		expect(file("# just notes").errors[0]).toContain("Missing YAML frontmatter")
		expect(file("# just notes").script).toBeUndefined()
		const broken = file("---\nname: [oops\n---\nbody")
		expect(broken.errors[0]).toContain("not valid YAML")
		expect(broken.name).toBe("test-module")
	})

	it.each([
		["missing description", "---\ncommand: echo\n---\n", "description is required"],
		["missing command", "---\ndescription: d\n---\n", "command is required"],
		["uppercase name", "---\nname: Bad Name\ndescription: d\ncommand: echo\n---\n", "name must be lowercase"],
		["bad approval", "---\ndescription: d\ncommand: echo\napproval: sometimes\n---\n", "approval must be one of"],
		["options not a list", "---\ndescription: d\ncommand: echo\noptions: nope\n---\n", "options must be a list"],
		[
			"bad kind",
			"---\ndescription: d\ncommand: echo\noptions:\n  - name: a\n    kind: number\n---\n",
			"kind must be one of flag, text, choice",
		],
		[
			"choice without choices",
			"---\ndescription: d\ncommand: echo\noptions:\n  - name: a\n    kind: choice\n---\n",
			"needs choices or choicesFrom",
		],
		[
			"choices on a text option",
			"---\ndescription: d\ncommand: echo\noptions:\n  - name: a\n    kind: text\n    choices: [x]\n---\n",
			"only choice options take choices",
		],
		[
			"default outside choices",
			"---\ndescription: d\ncommand: echo\noptions:\n  - name: a\n    kind: choice\n    choices: [x]\n    default: y\n---\n",
			"default must be one of its choices",
		],
		[
			"duplicate option",
			"---\ndescription: d\ncommand: echo\noptions:\n  - {name: a, kind: flag}\n  - {name: a, kind: flag}\n---\n",
			'Option "a" is declared twice',
		],
		[
			"placeholder without an option",
			"---\ndescription: d\ncommand: echo {{missing}}\n---\n",
			"{{missing}}, which is not a declared option",
		],
		[
			"flag used as a value",
			"---\ndescription: d\ncommand: echo {{f}}\noptions:\n  - {name: f, kind: flag}\n---\n",
			'Flag "f" cannot be used as a value',
		],
		[
			"unclosed section",
			"---\ndescription: d\ncommand: echo {{#a}}x\noptions:\n  - {name: a, kind: flag}\n---\n",
			"never closed",
		],
	])("rejects %s", (_label, content, message) => {
		const parsed = file(content)
		expect(parsed.script).toBeUndefined()
		expect(parsed.errors.join("\n")).toContain(message)
	})
})

describe("setScriptApprovalInContent", () => {
	it("replaces an existing approval line and leaves the rest alone", () => {
		const next = setScriptApprovalInContent(VALID, "always_ask")
		expect(next).toContain("approval: always_ask")
		expect(next).not.toContain("always_allow")
		expect(next.replace("approval: always_ask", "approval: always_allow")).toBe(VALID)
	})

	it("adds the line when missing and ignores files without frontmatter", () => {
		const next = setScriptApprovalInContent("---\ndescription: d\ncommand: echo\n---\nbody", "always_allow")
		expect(next).toBe("---\ndescription: d\ncommand: echo\napproval: always_allow\n---\nbody")
		expect(setScriptApprovalInContent("no frontmatter", "always_ask")).toBe("no frontmatter")
	})
})

describe("scriptTemplate", () => {
	it("produces a valid script", () => {
		const parsed = file(scriptTemplate("greet"), "greet")
		expect(parsed.errors).toEqual([])
		expect(parsed.script?.name).toBe("greet")
		expect(parsed.script?.options.map((option) => option.name)).toEqual(["who", "shout"])
	})
})
