import { describe, expect, it } from "vitest"
import { BUILTIN_SLASH_COMMANDS, collapseBuiltinSlashCommands } from "./builtin-slash-commands"
import { expandSlashCommands } from "./slash-command-expansion"

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("expands /deep-planning through the shared slash-command machinery", () => {
		const result = expandSlashCommands("/deep-planning add a factorial function", BUILTIN_SLASH_COMMANDS)
		expect(result).toContain('<explicit_instructions type="deep-planning">')
		expect(result).toContain("add a factorial function")
		expect(result).not.toContain("/deep-planning")
	})

	it("expands /skill into a normal turn that stages a skill or workflow", () => {
		const result = expandSlashCommands("/skill only the release steps", BUILTIN_SLASH_COMMANDS)
		expect(result).toContain('<explicit_instructions type="skill">')
		expect(result).toContain("skill_draft")
		expect(result).toContain("only the release steps")
	})

	it("shows a sent built-in as the command the user typed", () => {
		const sent = expandSlashCommands("/skill only the release steps", BUILTIN_SLASH_COMMANDS)
		expect(collapseBuiltinSlashCommands(sent)).toBe("/skill only the release steps")
		expect(collapseBuiltinSlashCommands(expandSlashCommands("/deep-planning", BUILTIN_SLASH_COMMANDS))).toBe("/deep-planning")
		expect(collapseBuiltinSlashCommands("plain text")).toBe("plain text")
	})

	it("leaves URLs and unrelated text unchanged", () => {
		expect(expandSlashCommands("see http://x.com/deep-planning", BUILTIN_SLASH_COMMANDS)).toBe(
			"see http://x.com/deep-planning",
		)
		expect(expandSlashCommands("hello world", BUILTIN_SLASH_COMMANDS)).toBe("hello world")
	})
})
