#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ApiConfigProfile } from "../../src/shared/api-profiles"
import type { Secrets } from "../../src/shared/storage/state-keys"
import { apiConfigurationForProfileId, type ApiProfileStore } from "../../src/core/controller/models/apiProfiles"
import type { ApiHandler } from "@cline/llms"
import { mock } from "bun:test"
import { fallback, generate, type ContentChange } from "../../src/services/walkthrough/engine"
import { scoreWalkthrough } from "./score"

const args = process.argv.slice(2)
const option = (name: string) => {
	const index = args.indexOf(name)
	return index >= 0 ? args[index + 1] : undefined
}
const profileId = option("--profile")
const configFile = option("--config")
const dryRun = args.includes("--dry-run")
if (!dryRun && (!profileId || !configFile))
	throw new Error(
		"Usage: bun evals/walkthrough/run.ts --config /path/to/profiles.json --profile ID [--output report.json] [--baseline prior-report.json]; or --dry-run",
	)
const cases = JSON.parse(await readFile(path.join(import.meta.dir, "cases.json"), "utf8")) as {
	id: string
	concepts: string[]
	files: { path: string; before: string; after: string }[]
}[]
let handler: ApiHandler | undefined
if (!dryRun) {
	const shim = await import("../../src/test/vscode-vitest-stub")
	mock.module("vscode", () => shim)
	const { buildApiHandler } = await import("../../src/sdk/sdk-api-handler")
	const config = JSON.parse(await readFile(configFile!, "utf8")) as {
		profiles: ApiConfigProfile[]
		secrets?: Record<string, Partial<Secrets>>
	}
	const secrets = config.secrets?.[profileId!] ?? {}
	const store = {
		getGlobalStateKey: (key: string) => (key === "apiConfigProfiles" ? config.profiles : undefined),
		listSecretStorageKeys: () => Object.keys(secrets).map((key) => `profile:${profileId}:${key}`),
		getSecretForKey: (key: string) => secrets[key.replace(`profile:${profileId}:`, "") as keyof Secrets],
	} as unknown as ApiProfileStore
	handler = buildApiHandler(apiConfigurationForProfileId(store, profileId!, "act"), "act")
}
const reports = []
for (const fixture of cases) {
	const changes: ContentChange[] = fixture.files.map((file) => ({
		filePath: `/fixture/${file.path}`,
		...file,
		beforeExists: true,
		afterExists: true,
	}))
	const live = fallback(fixture.id, "git", [], changes)
	const started = Date.now()
	const walk = handler ? await generate(live, [], handler) : live
	const report = { id: fixture.id, ms: Date.now() - started, ...scoreWalkthrough(walk, fixture.concepts), walkthrough: walk }
	reports.push(report)
	console.log(`${fixture.id}: ${dryRun ? "dry-run structure" : "score"} ${report.score}/100, ${report.ms}ms`)
}
const baselineFile = option("--baseline")
if (baselineFile && !dryRun) {
	const baseline = JSON.parse(await readFile(baselineFile, "utf8")) as { id: string; score: number }[]
	for (const report of reports) {
		const previous = baseline.find((item) => item.id === report.id)
		if (previous && report.score < previous.score * 0.9) {
			console.error(`${report.id}: quality dropped by more than 10%`)
			process.exitCode = 1
		}
	}
}
if (option("--output")) await writeFile(option("--output")!, JSON.stringify(reports, null, 2), "utf8")
