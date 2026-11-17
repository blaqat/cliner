import { describe, expect, it } from "vitest"
import { composerPlaceholder } from "./composerPlaceholder"

describe("composerPlaceholder", () => {
	it.each([
		[{ inThread: false, onTaskPage: false }, "Ask Cline anything · @ for context, / for commands"],
		[{ inThread: true, onTaskPage: false }, "Message Cline · @ for context, / for commands"],
		[{ inThread: false, onTaskPage: true }, "New thread in this task · @ for context, / for commands"],
	])("%o → %s", (where, text) => {
		expect(composerPlaceholder(where)).toBe(text)
	})

	it("never starts with @ (it sits right above the 📎 button)", () => {
		for (const inThread of [true, false]) {
			for (const onTaskPage of [true, false]) {
				expect(composerPlaceholder({ inThread, onTaskPage }).startsWith("@")).toBe(false)
			}
		}
	})
})
