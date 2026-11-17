import { describe, expect, it } from "vitest"
import {
	applyTerminalEnvironmentPatch,
	globalEnvFilePathProblem,
	maskTerminalEnvironmentScope,
	TERMINAL_ENV_UNCHANGED,
} from "./terminal-environment"

describe("maskTerminalEnvironmentScope", () => {
	it("keeps names and non-secret fields but never values", () => {
		const masked = maskTerminalEnvironmentScope({
			variables: { TOKEN: "ghp_secret", EDITOR: "vim" },
			envFilePath: "/tmp/x.env",
			pathEntries: ["/opt/bin"],
		})
		expect(masked.variables).toEqual({ TOKEN: TERMINAL_ENV_UNCHANGED, EDITOR: TERMINAL_ENV_UNCHANGED })
		expect(JSON.stringify(masked)).not.toContain("ghp_secret")
		expect(masked.envFilePath).toBe("/tmp/x.env")
		expect(masked.pathEntries).toEqual(["/opt/bin"])
	})
})

describe("applyTerminalEnvironmentPatch", () => {
	const stored = { variables: { A: "1", B: "2" }, envFilePath: "/e.env", pathEntries: ["/a", "/b"] }

	it("changes only what the patch names", () => {
		const next = applyTerminalEnvironmentPatch(stored, { setVariables: { A: "x" } })
		expect(next).toEqual({ variables: { A: "x", B: "2" }, envFilePath: "/e.env", pathEntries: ["/a", "/b"] })
	})

	it("composes a value save followed by a remove without losing either", () => {
		const afterSave = applyTerminalEnvironmentPatch(stored, { setVariables: { A: "new" } })
		const afterRemove = applyTerminalEnvironmentPatch(afterSave, { removeVariables: ["B"] })
		expect(afterRemove.variables).toEqual({ A: "new" })
	})

	it("never overwrites a stored secret with the unchanged sentinel", () => {
		const next = applyTerminalEnvironmentPatch(stored, { setVariables: { A: TERMINAL_ENV_UNCHANGED } })
		expect(next.variables).toEqual({ A: "1", B: "2" })
	})

	it("sets, clears and keeps the .env path", () => {
		expect(applyTerminalEnvironmentPatch(stored, {}).envFilePath).toBe("/e.env")
		expect(applyTerminalEnvironmentPatch(stored, { envFilePath: " /n.env " }).envFilePath).toBe("/n.env")
		expect(applyTerminalEnvironmentPatch(stored, { envFilePath: "" }).envFilePath).toBeUndefined()
	})

	it("adds and removes PATH entries individually", () => {
		const next = applyTerminalEnvironmentPatch(stored, { addPathEntries: ["/c", "/a", " "], removePathEntries: ["/b"] })
		expect(next.pathEntries).toEqual(["/a", "/c"])
	})

	it("starts from nothing", () => {
		expect(applyTerminalEnvironmentPatch(undefined, { setVariables: { N: "v" } })).toEqual({
			variables: { N: "v" },
			envFilePath: undefined,
			pathEntries: [],
		})
	})
})

describe("globalEnvFilePathProblem", () => {
	it("accepts absolute and ~-relative paths and empty", () => {
		for (const ok of ["", "  ", "/etc/x.env", "~/x.env", "~", "C:\\x.env", "C:/x.env", "\\\\host\\share\\x.env"]) {
			expect(globalEnvFilePathProblem(ok)).toBeUndefined()
		}
	})
	it("explains relative paths", () => {
		expect(globalEnvFilePathProblem(".env")).toContain("absolute or start with ~")
		expect(globalEnvFilePathProblem("config/.env")).toBeTruthy()
	})
})
