import { exec } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { quoteShellValue } from "./script-command"

it.skipIf(process.platform !== "win32")(
	"passes trailing backslashes through the real Windows shell and argv decoder",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "script-windows-"))
		try {
			const file = path.join(root, "argv.cjs")
			await fs.writeFile(file, "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
			const values = ["C:\\space path\\", "C:\\space path\\\\", "C:\\plain\\", "", "two words"]
			const command = [process.execPath, file, ...values].map((value) => quoteShellValue(value, "win32")).join(" ")
			const { stdout } = await promisify(exec)(command, { cwd: root })
			expect(JSON.parse(stdout)).toEqual(values)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	},
)
