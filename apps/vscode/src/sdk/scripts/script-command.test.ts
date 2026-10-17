import type { ScriptOption } from "@shared/scripts"
import { describe, expect, it } from "vitest"
import { parseCommandTemplate, quoteShellValue, resolveScriptRun, validateCommandTemplate } from "./script-command"

const options: ScriptOption[] = [
	{ name: "module", kind: "choice", required: true, description: "", choices: ["api", "web"] },
	{ name: "filter", kind: "text", required: false, description: "" },
	{ name: "watch", kind: "flag", required: false, description: "" },
	{ name: "quiet", kind: "flag", required: false, description: "", default: true },
]
const script = {
	command:
		"bun run test --filter {{module}}{{#filter}} -t {{filter}}{{/filter}}{{#watch}} --watch{{/watch}}{{^quiet}} --verbose{{/quiet}}",
	options,
}

describe("resolveScriptRun", () => {
	it("substitutes values and includes sections for set options", () => {
		const run = resolveScriptRun(script, { module: "api", filter: "slow tests", watch: true }, "linux")
		expect(run).toEqual({
			ok: true,
			values: { module: "api", filter: "slow tests", watch: true, quiet: true },
			command: "bun run test --filter api -t 'slow tests' --watch",
		})
	})

	it("omits unset sections and renders inverse sections", () => {
		const run = resolveScriptRun(script, { module: "web", quiet: false }, "linux")
		expect(run).toMatchObject({ ok: true, command: "bun run test --filter web --verbose" })
	})

	it("applies defaults and requires required options", () => {
		expect(resolveScriptRun(script, undefined, "linux")).toEqual({ ok: false, error: 'Option "module" is required.' })
		expect(
			resolveScriptRun({ command: "run {{module}}", options: [{ ...options[0], default: "api" }] }, {}, "linux"),
		).toMatchObject({
			ok: true,
			values: { module: "api" },
		})
	})

	it("rejects undeclared options", () => {
		const run = resolveScriptRun(script, { module: "api", extra: "--rm -rf /" }, "linux")
		expect(run).toEqual({ ok: false, error: 'Unknown option "extra". Declared options: module, filter, watch, quiet.' })
	})

	it("rejects choices that are not declared", () => {
		const run = resolveScriptRun(script, { module: "api; rm -rf /" }, "linux")
		expect(run).toMatchObject({ ok: false })
		expect((run as { error: string }).error).toContain("must be one of: api, web")
	})

	it("rejects wrong types and control characters", () => {
		expect(resolveScriptRun(script, { module: "api", watch: "maybe" }, "linux")).toMatchObject({ ok: false })
		expect(resolveScriptRun(script, { module: "api", filter: { a: 1 } }, "linux")).toMatchObject({ ok: false })
		expect(resolveScriptRun(script, { module: "api", filter: "a\nrm -rf /" }, "linux")).toMatchObject({ ok: false })
		expect(resolveScriptRun(script, { module: "api", filter: "a\u0000b" }, "linux")).toMatchObject({ ok: false })
		expect(resolveScriptRun(script, { module: "api", filter: "x".repeat(2001) }, "linux")).toMatchObject({ ok: false })
	})

	it("accepts flags as true/false strings from a model", () => {
		expect(resolveScriptRun(script, { module: "api", watch: "true" }, "linux")).toMatchObject({ ok: true })
		const off = resolveScriptRun(script, { module: "api", watch: "false" }, "linux")
		expect(off).toMatchObject({ ok: true, command: "bun run test --filter api" })
	})

	it("keeps injection attempts inside one quoted word", () => {
		for (const attack of [
			"$(touch /tmp/pwned)",
			"`id`",
			"a; rm -rf /",
			"x' ; echo pwned ; '",
			"a && b || c | d > e",
			'"; id; "',
			"${HOME}",
			"a\\",
		]) {
			const run = resolveScriptRun(script, { module: "api", filter: attack }, "linux")
			expect(run.ok).toBe(true)
			const command = (run as { command: string }).command
			expect(command.startsWith("bun run test --filter api -t '")).toBe(true)
			// Undo POSIX single quoting: the value must survive as exactly one word.
			const quoted = command.slice("bun run test --filter api -t ".length)
			expect(quoted.replace(/^'|'$/g, "").replace(/'\\''/g, "'")).toBe(attack)
		}
	})

	it("does not collapse whitespace inside quoted values", () => {
		const run = resolveScriptRun(script, { module: "api", filter: "a   b" }, "linux")
		expect((run as { command: string }).command).toContain("'a   b'")
	})

	it("refuses unsafe characters on Windows instead of guessing at escaping", () => {
		expect(resolveScriptRun(script, { module: "api", filter: "a & calc" }, "win32")).toMatchObject({ ok: false })
		expect(resolveScriptRun(script, { module: "api", filter: "slow tests" }, "win32")).toMatchObject({
			ok: true,
			command: 'bun run test --filter api -t "slow tests"',
		})
	})
})

describe("quoteShellValue", () => {
	it("leaves simple words bare and quotes the rest", () => {
		expect(quoteShellValue("src/app.ts")).toBe("src/app.ts")
		expect(quoteShellValue("")).toBe("''")
		expect(quoteShellValue("it's")).toBe("'it'\\''s'")
	})
})

describe("command templates", () => {
	it("flags nested, unclosed and stray tags", () => {
		expect(parseCommandTemplate("{{#a}}{{#b}}x{{/b}}{{/a}}").errors[0]).toContain("cannot be nested")
		expect(parseCommandTemplate("{{#a}}x").errors[0]).toContain("never closed")
		expect(parseCommandTemplate("x {{/a}}").errors[0]).toContain("closes a section that is not open")
		expect(parseCommandTemplate("echo {{ not valid }}").errors[0]).toContain("{{")
	})

	it("validates references against the declared options", () => {
		expect(validateCommandTemplate("echo {{module}} {{#watch}}w{{/watch}}", options)).toEqual([])
		expect(validateCommandTemplate("echo {{ghost}}", options)[0]).toContain("not a declared option")
		expect(validateCommandTemplate("echo {{watch}}", options)[0]).toContain("cannot be used as a value")
	})
})

describe("Windows argv quoting", () => {
	it("doubles trailing backslashes before a closing quote", () => {
		for (const count of [1, 2, 3]) {
			const value = "C:\\space path" + "\\".repeat(count)
			expect(quoteShellValue(value, "win32")).toBe('"C:\\space path' + "\\".repeat(count * 2) + '"')
		}
		expect(quoteShellValue("C:\\plain\\", "win32")).toBe("C:\\plain\\")
		expect(quoteShellValue("", "win32")).toBe('""')
	})
	it.each([
		"%PATH%",
		"x&calc",
		"x|calc",
		"x>file",
		'x"y',
		"!VAR!",
	])("continues to refuse cmd expansion and metacharacters: %s", (value) => {
		expect(() => quoteShellValue(value, "win32")).toThrow("Windows")
	})
})
