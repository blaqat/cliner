import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** Read the shared stores without constructing managers, auto-migrating, or changing their bytes. */
export async function readSdkMigrationInput(dataDir: string): Promise<Record<string, unknown>> {
	const read = async (file: string) => {
		try {
			return JSON.parse(await readFile(join(dataDir, "settings", file), "utf8")) as unknown
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw new Error("Invalid SDK migration input")
		}
	}
	const [providers, models] = await Promise.all([read("providers.json"), read("models.json")])
	return { providers, models }
}
