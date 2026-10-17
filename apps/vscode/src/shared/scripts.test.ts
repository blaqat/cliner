import { describe, expect, it } from "vitest"
import {
	completeTypedOptions,
	formatTypedOptions,
	isTypedOptionsComplete,
	missingRequiredOptions,
	parseTypedOptions,
	type ScriptOption,
	setTypedOption,
	splitScriptInvocation,
	tokenizeTypedOptions,
	typedFocus,
	typedOptionsHint,
} from "./scripts"

const OPTIONS: ScriptOption[] = [
	{ name: "module", kind: "choice", required: true, description: "Module to test", choices: ["api", "web", "shared"] },
	{ name: "filter", kind: "text", required: false, description: "Test name pattern" },
	{ name: "watch", kind: "flag", required: false, description: "Re-run on change" },
	{ name: "coverage", kind: "flag", required: false, description: "Collect coverage" },
]

describe("tokenizeTypedOptions", () => {
	it("splits names, colon values and quoted values", () => {
		const tokens = tokenizeTypedOptions(`module:api watch filter:"slow tests" other:'a b'`)
		expect(tokens.map((token) => [token.name, token.hasColon, token.value])).toEqual([
			["module", true, "api"],
			["watch", false, ""],
			["filter", true, "slow tests"],
			["other", true, "a b"],
		])
	})

	it("supports escaped quotes and flags an unclosed quote", () => {
		expect(tokenizeTypedOptions(String.raw`filter:"say \"hi\""`)[0].value).toBe('say "hi"')
		const [open] = tokenizeTypedOptions(`filter:"still typing`)
		expect(open.unclosed).toBe(true)
		expect(open.value).toBe("still typing")
	})

	it("keeps colons inside a value", () => {
		expect(tokenizeTypedOptions("filter:a:b")[0].value).toBe("a:b")
	})
})

describe("parseTypedOptions", () => {
	it("reads colon values and bare flags", () => {
		const parsed = parseTypedOptions("module:api watch ", OPTIONS)
		expect(parsed.values).toEqual({ module: "api", watch: true })
		expect(parsed.issues).toEqual([])
		expect(parsed.missing).toEqual([])
		expect(parsed.partial).toBeNull()
	})

	it("treats the last token as partial until whitespace follows, and does not validate it", () => {
		const parsed = parseTypedOptions("module:ap", OPTIONS)
		expect(parsed.partial?.value).toBe("ap")
		expect(parsed.values).toEqual({})
		expect(parsed.issues).toEqual([])
		expect(parsed.missing.map((option) => option.name)).toEqual(["module"])
	})

	it("validates every token when final", () => {
		const parsed = parseTypedOptions("module:ap", OPTIONS, { final: true })
		expect(parsed.partial).toBeNull()
		expect(parsed.issues[0].message).toContain("must be one of api, web, shared")
	})

	it("reports unknown, duplicate, valueless and flag-with-value options", () => {
		const messages = parseTypedOptions("nope module:api module:web filter watch:yes ", OPTIONS).issues.map(
			(issue) => issue.message,
		)
		expect(messages).toEqual([
			'Unknown option "nope"',
			"module is given twice",
			"filter needs a value: filter:<value>",
			"watch is a flag; type it without a value",
		])
	})

	it("counts a default as satisfying a required option", () => {
		const withDefault: ScriptOption[] = [{ ...OPTIONS[0], default: "api" }]
		expect(missingRequiredOptions(withDefault, {})).toEqual([])
	})

	it("holds an open quote as partial", () => {
		const parsed = parseTypedOptions(`module:api filter:"a b `, OPTIONS)
		expect(parsed.partial?.unclosed).toBe(true)
		expect(parsed.values).toEqual({ module: "api" })
	})
})

describe("send validation", () => {
	it("is complete only with required options and nothing invalid", () => {
		expect(isTypedOptionsComplete("", OPTIONS)).toBe(false)
		expect(isTypedOptionsComplete("module:api", OPTIONS)).toBe(true)
		expect(isTypedOptionsComplete("module:api bogus", OPTIONS)).toBe(false)
		expect(isTypedOptionsComplete("module:nope", OPTIONS)).toBe(false)
	})

	it("gives one hint", () => {
		expect(typedOptionsHint("watch", OPTIONS)).toBe("Needs module")
		expect(typedOptionsHint("module:api", OPTIONS)).toBeNull()
		expect(typedOptionsHint("bogus module:api", OPTIONS)).toBe('Unknown option "bogus"')
	})
})

describe("typedFocus", () => {
	it("tracks the option whose value is being typed", () => {
		const focus = typedFocus("module:ap", OPTIONS)
		expect(focus.option?.name).toBe("module")
		expect(focus.partial).toBe("ap")
	})

	it("filters option names by the bare word typed", () => {
		expect(typedFocus("module:api wa", OPTIONS).nameMatches.map((option) => option.name)).toEqual(["watch"])
		expect(typedFocus("c", OPTIONS).nameMatches.map((option) => option.name)).toEqual(["coverage"])
		expect(typedFocus("module:api ", OPTIONS).nameMatches).toEqual([])
	})
})

describe("completeTypedOptions (Tab)", () => {
	it("jumps to the first missing required option from an empty line", () => {
		expect(completeTypedOptions("", OPTIONS)).toBe("module:")
	})

	it("completes a partial choice, then there is nothing missing", () => {
		expect(completeTypedOptions("module:a", OPTIONS)).toBe("module:api ")
		expect(completeTypedOptions("module:", OPTIONS)).toBe("module:api ")
	})

	it("leaves an unmatched choice alone", () => {
		expect(completeTypedOptions("module:zzz", OPTIONS)).toBe("module:zzz")
	})

	it("completes an option name: flags get a space, values a colon", () => {
		expect(completeTypedOptions("module:api wa", OPTIONS)).toBe("module:api watch ")
		expect(completeTypedOptions("module:api fi", OPTIONS)).toBe("module:api filter:")
	})

	it("skips options that are already set", () => {
		expect(completeTypedOptions("watch w", OPTIONS)).toBe("watch w")
		expect(completeTypedOptions("module:api watch c", OPTIONS)).toBe("module:api watch coverage ")
	})

	it("jumps to the next missing required option after completing", () => {
		const two: ScriptOption[] = [
			{ name: "env", kind: "choice", required: true, description: "", choices: ["dev", "prod"] },
			{ name: "region", kind: "text", required: true, description: "" },
			{ name: "dry", kind: "flag", required: false, description: "" },
		]
		expect(completeTypedOptions("env:p", two)).toBe("env:prod region:")
		expect(completeTypedOptions("dry ", two)).toBe("dry env:")
	})

	it("commits a typed text value and moves on", () => {
		const two: ScriptOption[] = [
			{ name: "name", kind: "text", required: true, description: "" },
			{ name: "env", kind: "choice", required: true, description: "", choices: ["dev"] },
		]
		expect(completeTypedOptions("name:foo", two)).toBe("name:foo env:")
		expect(completeTypedOptions("name:", two)).toBe("name:")
	})

	it("does nothing when everything required is set", () => {
		expect(completeTypedOptions("module:api ", OPTIONS)).toBe("module:api ")
	})
})

describe("setTypedOption", () => {
	it("appends a flag or value", () => {
		expect(setTypedOption("module:api ", OPTIONS, "watch")).toBe("module:api watch ")
		expect(setTypedOption("", OPTIONS, "module", "web")).toBe("module:web ")
		expect(setTypedOption("module:api ", OPTIONS, "filter", "")).toBe("module:api filter:")
	})

	it("replaces an earlier value and the bare word being typed", () => {
		expect(setTypedOption("module:api ", OPTIONS, "module", "web")).toBe("module:web ")
		expect(setTypedOption("module:ap", OPTIONS, "module", "api")).toBe("module:api ")
		expect(setTypedOption("module:api wa", OPTIONS, "watch")).toBe("module:api watch ")
	})

	it("quotes values with spaces", () => {
		expect(setTypedOption("", OPTIONS, "filter", "slow tests")).toBe('filter:"slow tests" ')
	})
})

describe("formatTypedOptions", () => {
	it("echoes values in declaration order", () => {
		expect(formatTypedOptions(OPTIONS, { watch: true, filter: "a b", module: "api" })).toBe('module:api filter:"a b" watch')
	})
})

describe("splitScriptInvocation", () => {
	it("splits the name, the first line of options and a note", () => {
		expect(splitScriptInvocation("/test-module module:api watch\nthen fix failures")).toEqual({
			name: "test-module",
			optionsText: "module:api watch",
			note: "then fix failures",
		})
		expect(splitScriptInvocation("/deploy")).toEqual({ name: "deploy", optionsText: "", note: "" })
	})

	it("ignores text that does not start with a script token", () => {
		expect(splitScriptInvocation("please run /deploy")).toBeNull()
		expect(splitScriptInvocation("/Deploy")).toBeNull()
		expect(splitScriptInvocation("/deploy.md")).toBeNull()
	})
})
