import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { resolveScriptRun } from "./script-command"

const option = { name: "value", kind: "text" as const, required: true, description: "" }

describe("script shell boundaries", () => {
	it("executes hostile text literally and refuses unsafe template contexts", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "script-shell-"))
		try {
			const value = "$(touch injected) `touch injected` 'quoted'"
			const run = resolveScriptRun({ command: "printf '%s' {{value}}", options: [option] }, { value })
			expect(run.ok).toBe(true)
			if (!run.ok) throw new Error(run.error)
			expect((await promisify(execFile)("/bin/sh", ["-c", run.command], { cwd: root })).stdout).toBe(value)
			for (const command of [
				'echo "{{value}}"',
				"echo '{{value}}'",
				"echo $(printf {{value}})",
				"echo `printf {{value}}`",
				"echo prefix{{value}}",
				"echo {{value}}suffix",
				'echo "{{#flag}}{{value}}{{/flag}}"',
				"echo {{value}}{{#flag}} safe{{/flag}}suffix",
			]) {
				expect(
					resolveScriptRun(
						{ command, options: [option, { name: "flag", kind: "flag", required: false, description: "" }] },
						{ value, flag: true },
					).ok,
					command,
				).toBe(false)
			}
			expect(await fs.readdir(root)).toEqual([])
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
