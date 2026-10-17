import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseEnvFile, resolveTerminalEnv } from "./terminal-env"

let tempDir: string

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-terminal-env-"))
})

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true })
})

describe("parseEnvFile", () => {
	it("parses comments, export prefixes, and quoted values", () => {
		const vars = parseEnvFile(
			["# comment", "A=1", "export B=two", 'C="quoted value"', "D='single'", "", "not a var line", "E=  spaced  "].join(
				"\n",
			),
		)
		expect(vars).toEqual({ A: "1", B: "two", C: "quoted value", D: "single", E: "spaced" })
	})
})

describe("resolveTerminalEnv", () => {
	it("merges process -> env file -> global -> workspace in order", async () => {
		const envFile = path.join(tempDir, ".env")
		await fs.writeFile(envFile, ["SHARED=file", "FILE_ONLY=file"].join("\n"))
		const resolved = await resolveTerminalEnv({
			baseEnv: { SHARED: "process", PROCESS_ONLY: "process" },
			global: { envFilePath: envFile, variables: { SHARED: "global", GLOBAL_ONLY: "global" } },
			workspace: { variables: { SHARED: "workspace", WS_ONLY: "workspace" } },
		})
		expect(resolved.env.SHARED).toBe("workspace")
		expect(resolved.env.FILE_ONLY).toBe("file")
		expect(resolved.env.GLOBAL_ONLY).toBe("global")
		expect(resolved.env.WS_ONLY).toBe("workspace")
		expect(resolved.env.PROCESS_ONLY).toBe("process")
		// Process env flows through without becoming a "source" entry.
		expect(resolved.sources.PROCESS_ONLY).toBeUndefined()
		expect(resolved.sources.SHARED).toEqual({ source: "workspace", overridden: "global" })
		expect(resolved.sources.FILE_ONLY).toEqual({ source: "env_file" })
		// overrides holds only what Cline adds on top of the base env.
		expect(resolved.overrides.PROCESS_ONLY).toBeUndefined()
		expect(resolved.overrides.SHARED).toBe("workspace")
	})

	it("workspace .env file wins over the global one but not over variables", async () => {
		const globalFile = path.join(tempDir, "global.env")
		const workspaceFile = path.join(tempDir, "workspace.env")
		await fs.writeFile(globalFile, "FROM_FILES=global-file")
		await fs.writeFile(workspaceFile, "FROM_FILES=workspace-file")
		const resolved = await resolveTerminalEnv({
			baseEnv: {},
			global: { envFilePath: globalFile, variables: { FROM_FILES: "global-var" } },
			workspace: { envFilePath: workspaceFile },
		})
		expect(resolved.env.FROM_FILES).toBe("global-var")
		expect(resolved.sources.FROM_FILES).toEqual({ source: "global", overridden: "env_file" })
	})

	it("prepends workspace then global PATH entries over the merged PATH", async () => {
		const envFile = path.join(tempDir, ".env")
		await fs.writeFile(envFile, "PATH=/from/file")
		const resolved = await resolveTerminalEnv({
			baseEnv: { PATH: "/usr/bin:/bin" },
			global: { envFilePath: envFile, pathEntries: ["/global/bin"] },
			workspace: { pathEntries: ["/ws/bin", " /also/ws "] },
		})
		const expected = ["/ws/bin", "/also/ws", "/global/bin", "/from/file"].join(path.delimiter)
		expect(resolved.env.PATH).toBe(expected)
		expect(resolved.overrides.PATH).toBe(expected)
	})

	it("leaves PATH untouched when no entries are configured", async () => {
		const resolved = await resolveTerminalEnv({ baseEnv: { PATH: "/usr/bin" }, global: {} })
		expect(resolved.env.PATH).toBe("/usr/bin")
		expect(resolved.overrides.PATH).toBeUndefined()
	})

	it("resolves relative .env paths against cwd and ignores missing files", async () => {
		await fs.writeFile(path.join(tempDir, "local.env"), "REL=yes")
		const resolved = await resolveTerminalEnv({
			baseEnv: {},
			cwd: tempDir,
			workspace: { envFilePath: "local.env" },
			global: { envFilePath: "/does/not/exist.env" },
		})
		expect(resolved.env.REL).toBe("yes")
		expect(resolved.sources.REL).toEqual({ source: "env_file" })
	})
})
