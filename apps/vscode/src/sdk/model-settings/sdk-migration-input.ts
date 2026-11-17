import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ModelSettingsMigrationError } from "@/core/storage/model-settings-migration"

/** Read the shared stores without constructing managers, auto-migrating, or changing their bytes. */
export async function readSdkMigrationInput(dataDir: string): Promise<Record<string, unknown>> {
	const unreadable: string[] = []
	const read = async (file: string) => {
		let text: string
		try {
			text = await readFile(join(dataDir, "settings", file), "utf8")
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ENOENT") return undefined
			throw new ModelSettingsMigrationError(`Could not read ${file} (${code ?? "unknown error"})`)
		}
		// Corrupt JSON can't heal on retry, and legacy settings shouldn't wait on it. The migration records the loss.
		try {
			return JSON.parse(text) as unknown
		} catch {
			unreadable.push(file)
			return undefined
		}
	}
	const [providers, models] = await Promise.all([read("providers.json"), read("models.json")])
	return { providers, models, unreadable }
}
