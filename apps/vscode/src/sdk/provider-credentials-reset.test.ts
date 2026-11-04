import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

// Vitest swaps @cline/core for a stub, so this runs the real SDK manager in Bun against an isolated data dir.
function clearAndRead(dataDir: string): Record<string, any> {
	const script = `
		import { clearProviderCredentials, getProviderSettingsManager } from "./src/sdk/provider-migration"
		clearProviderCredentials(process.argv[1])
		console.log(JSON.stringify(getProviderSettingsManager(process.argv[1]).read()))
	`
	const env = { ...process.env, CLINE_DATA_DIR: dataDir, CLINE_DIR: dataDir, HOME: dataDir }
	const stdout = execFileSync("bun", ["--eval", script, dataDir], { encoding: "utf8", env })
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")
}

describe("clearProviderCredentials", () => {
	let dir: string
	const file = () => join(dir, "settings", "providers.json")
	const entry = (settings: object) => ({ settings, updatedAt: "2026-01-01T00:00:00.000Z", tokenSource: "manual" })
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "settings-reset-providers-"))
		mkdirSync(join(dir, "settings"))
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it("removes every credential, keeps the rest, and leaves a valid file", () => {
		writeFileSync(
			file(),
			JSON.stringify({
				version: 1,
				lastUsedProvider: "anthropic",
				providers: {
					anthropic: entry({
						provider: "anthropic",
						model: "claude",
						apiKey: "SECRET-1",
						baseUrl: "https://a.example/",
					}),
					cline: entry({
						provider: "cline",
						model: "c/m",
						auth: { accessToken: "SECRET-2", refreshToken: "SECRET-3", accountId: "SECRET-4" },
					}),
					bedrock: entry({
						provider: "bedrock",
						model: "b",
						aws: { accessKey: "SECRET-5", secretKey: "SECRET-6", sessionToken: "SECRET-7", region: "us-east-1" },
					}),
					sapaicore: entry({
						provider: "sapaicore",
						model: "s",
						sap: { clientId: "SECRET-8", clientSecret: "SECRET-9", resourceGroup: "rg" },
					}),
					"openai-compatible": entry({
						provider: "openai-compatible",
						model: "m",
						headers: { "X-Auth": "SECRET-10" },
					}),
				},
			}),
		)
		const state = clearAndRead(dir)
		expect(readFileSync(file(), "utf8")).not.toContain("SECRET")
		expect(state.lastUsedProvider).toBe("anthropic")
		expect(state.providers.anthropic.settings).toEqual({
			provider: "anthropic",
			model: "claude",
			baseUrl: "https://a.example/",
		})
		expect(state.providers.cline.settings).toEqual({ provider: "cline", model: "c/m" })
		expect(state.providers.bedrock.settings.aws).toEqual({ region: "us-east-1" })
		expect(state.providers.sapaicore.settings.sap).toEqual({ resourceGroup: "rg" })
	})
	it("replaces a file it can't read rather than leave a key in it", () => {
		writeFileSync(file(), '{ "apiKey": "SECRET-1", broken')
		const state = clearAndRead(dir)
		expect(readFileSync(file(), "utf8")).not.toContain("SECRET")
		expect(JSON.parse(readFileSync(file(), "utf8")).providers).toEqual({})
		expect(state.providers).toEqual({})
	})
	it("creates nothing when there's no file", () => {
		expect(clearAndRead(dir).providers).toEqual({})
		expect(existsSync(file())).toBe(false)
	})
})
