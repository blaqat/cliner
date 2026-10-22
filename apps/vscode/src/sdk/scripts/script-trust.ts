import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { ScriptDefinition } from "./script-file"

/** Path is part of identity: a workspace file cannot inherit a global file's trust. */
export function scriptFingerprint(script: ScriptDefinition): string {
	return createHash("sha256")
		.update(JSON.stringify([script.filePath, script.command, script.cwd ?? "", script.options, script.approval]))
		.digest("hex")
}

/** Kept in extension global storage, never in the script's editable frontmatter. */
export class ScriptTrustStore {
	private memory: Record<string, string> = {}
	private writing: Promise<void> = Promise.resolve()
	constructor(private readonly getFile?: () => string) {}
	private async read(): Promise<Record<string, string>> {
		if (!this.getFile) return this.memory
		try {
			return JSON.parse(await fs.readFile(this.getFile(), "utf8"))
		} catch {
			return {}
		}
	}
	async isTrusted(script: ScriptDefinition): Promise<boolean> {
		await this.writing
		return (await this.read())[script.filePath] === scriptFingerprint(script)
	}
	async trust(script: ScriptDefinition): Promise<void> {
		const fingerprint = scriptFingerprint(script)
		const write = this.writing.then(async () => {
			const next = { ...(await this.read()), [script.filePath]: fingerprint }
			if (this.getFile) {
				const file = this.getFile()
				await fs.mkdir(path.dirname(file), { recursive: true })
				await fs.writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
				await fs.rename(`${file}.tmp`, file)
			} else this.memory = next
		})
		this.writing = write.catch(() => {})
		await write
	}
}
