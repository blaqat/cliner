import { providerSpec } from "../models/providerSpecs"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { GlobalStateAndSettingKeys, SecretKeys, LocalStateKeys } from "@shared/storage/state-keys"
import classifications from "./stateKeyClassification.json"
import { SETTINGS_ROWS } from "./settingsRows"

// This is deliberately an explicit inventory. Do not auto-classify new keys by
// name or by their source group: a new preference must receive an ownership review.
describe("settings ownership audit", () => {
	it("classifies every exported persisted key", () => {
		const inventory: Record<string, string> = classifications
		const missing = [...GlobalStateAndSettingKeys, ...SecretKeys, ...LocalStateKeys].filter((key) => !inventory[key])
		expect(missing).toEqual([])
	})
	it("keeps every row classification attached to the page registry", () => {
		const rows = new Set(SETTINGS_ROWS.map((row) => row.id))
		const missing = Object.entries(classifications)
			.filter(([, owner]) => owner.startsWith("row:") && !rows.has(owner.slice(4)))
			.map(([key, owner]) => ({ key, owner }))
		expect(missing).toEqual([])
	})
	it("classifies every provider form registration", () => {
		const source = readFileSync("../src/shared/api.ts", "utf8")
		const union = source.split("export type ApiProvider =")[1].split("export const DEFAULT_API_PROVIDER")[0]
		const providers = [...union.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1])
		const inventory: Record<string, string> = classifications
		const missing = providers.flatMap((id) => {
			const spec = providerSpec(id)
			return [...spec.fields, ...(spec.modelFields ?? [])]
				.filter((field) => field.id !== "baseUrl" && !inventory[field.id])
				.map((field) => `${id}.${field.id}`)
		})
		expect(providers.length).toBeGreaterThan(0)
		expect(missing).toEqual([])
	})

	it("classifies SDK settings owned outside the extension or mapped to extension controls", () => {
		const source = readFileSync("../../../sdk/packages/core/src/services/global-settings.ts", "utf8")
		const schema = source.split("export const GlobalSettingsSchema = z")[1].split("\n\t})")[0]
		const keys = [...schema.matchAll(/^\t\t(\w+):/gm)].map((match) => match[1])
		const ownership = {
			telemetryOptOut: "data.reporting",
			compactionStrategy: "agent.compact.strategy",
			compactionEnabled: "agent.compact",
			tools: "tools.web-search",
			autoUpdateEnabled: "SDK",
			planActMode: "SDK",
			toolAutoApprove: "SDK",
			tuiTheme: "SDK",
			disabledTools: "SDK",
			disabledPlugins: "SDK",
			disabledAgentPlugins: "SDK",
		}
		expect(keys.length).toBeGreaterThan(0)
		expect(keys.filter((key) => !(key in ownership))).toEqual([])
	})
})
