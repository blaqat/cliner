import { describe, expect, it } from "vitest"
import { DATA_ROWS } from "../data/dataRows"
import { MODELS_ROWS } from "../models/modelsRows"
import { isRowChanged, type SettingsRowContext } from "./settingsRegistry"

const context = (state: Record<string, unknown>) => ({ state }) as unknown as SettingsRowContext
const row = (rows: readonly { id: string }[], id: string) => rows.find((r) => r.id === id) as never

describe("rows on settings nobody changed", () => {
	it("reporting that's on, set or not yet mirrored, isn't a change", () => {
		const reporting = row(DATA_ROWS, "data.reporting")
		expect(isRowChanged(reporting, context({ telemetrySetting: "enabled" }))).toBe(false)
		expect(isRowChanged(reporting, context({ telemetrySetting: "unset" }))).toBe(false)
		expect(isRowChanged(reporting, context({ telemetrySetting: "disabled" }))).toBe(true)
	})
	it("Ask switched off isn't a change, whatever pick it keeps", () => {
		const ask = row(MODELS_ROWS, "models.ask")
		const withAsk = (enabled: boolean) =>
			context({ modelSettings: { settings: { roles: { ask: { enabled, pick: { modelId: "m", levelId: "high" } } } } } })
		expect(isRowChanged(ask, withAsk(false))).toBe(false)
		expect(isRowChanged(ask, withAsk(true))).toBe(true)
	})
})
