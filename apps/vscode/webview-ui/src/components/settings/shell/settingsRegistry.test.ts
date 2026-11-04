import { describe, expect, it, vi } from "vitest"
import { SETTINGS_TARGET_REDIRECTS, settingsRowElementId } from "../settingsTargets"
import {
	changedRows,
	findRow,
	isRowChanged,
	isRowManaged,
	isRowVisible,
	type PreferenceRow,
	resetRow,
	resolveShellTarget,
	rowAncestors,
	type SettingsRow,
	type SettingsRowContext,
	searchRows,
} from "./settingsRegistry"
import { SETTINGS_ROWS } from "./settingsRows"

vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: {}, StateServiceClient: {} }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: vi.fn() }))

const context = (state: Record<string, unknown> = {}, isDev = false): SettingsRowContext =>
	({ state: { platform: "darwin", ...state }, activeOrganization: null, isDev }) as unknown as SettingsRowContext

const pref = (id: string, value: unknown, fallback: unknown, extra: Partial<PreferenceRow> = {}): PreferenceRow => ({
	id,
	page: "agent",
	label: id,
	kind: "preference",
	defaultValue: () => fallback,
	read: () => value,
	write: vi.fn(),
	...extra,
})

describe("the row registry", () => {
	it("has unique ids, each starting with its page", () => {
		const ids = SETTINGS_ROWS.map((row) => row.id)
		expect(new Set(ids).size).toBe(ids.length)
		for (const row of SETTINGS_ROWS) {
			expect(row.id.split(".")[0]).toBe(row.page)
		}
	})

	it("parents exist, on the same page", () => {
		for (const row of SETTINGS_ROWS) {
			if (row.parent) {
				expect(findRow(SETTINGS_ROWS, row.parent)?.page).toBe(row.page)
			}
		}
	})

	it("every redirect lands on a real page or row", () => {
		const ctx = { ...context({}, true), activeOrganization: { roles: ["admin"] } } as unknown as SettingsRowContext
		for (const [alias, destination] of Object.entries(SETTINGS_TARGET_REDIRECTS)) {
			const resolved = resolveShellTarget(SETTINGS_ROWS, alias, ctx)
			expect(resolved?.pageId, alias).toBeDefined()
			if (destination.includes(".")) {
				expect(findRow(SETTINGS_ROWS, destination), alias).toBeDefined()
				expect(resolved?.elementId, alias).toBe(settingsRowElementId(destination))
			}
		}
	})

	it("only locks rows with names the org schema can set", () => {
		const reporting = findRow(SETTINGS_ROWS, "data.reporting") as SettingsRow
		expect(isRowManaged(reporting, context({ remoteConfigSettings: { telemetrySetting: "enabled" } }))).toBe(true)
		expect(isRowManaged(reporting, context({ remoteConfigSettings: { hooksEnabled: true } }))).toBe(false)
		expect(
			isRowManaged(
				findRow(SETTINGS_ROWS, "tools.hooks") as SettingsRow,
				context({ remoteConfigSettings: { hooksEnabled: false } }),
			),
		).toBe(false)
	})

	it("an empty provider list doesn't count as managed", () => {
		const connections = findRow(SETTINGS_ROWS, "models.connections") as SettingsRow
		expect(isRowManaged(connections, context({ remoteConfigSettings: { remoteConfiguredProviders: [] } }))).toBe(false)
		expect(isRowManaged(connections, context({ remoteConfigSettings: { remoteConfiguredProviders: ["openai"] } }))).toBe(true)
	})
})

describe("Changed", () => {
	const ctx = context()

	it("counts leaf preferences, not actions or state", () => {
		const rows: SettingsRow[] = [
			pref("agent.a", 1, 0),
			pref("agent.same", 1, 1),
			{ id: "agent.b", page: "agent", label: "b", kind: "action" },
			{ id: "agent.c", page: "agent", label: "c", kind: "state" },
		]
		expect(changedRows(rows, ctx).map((row) => row.id)).toEqual(["agent.a"])
	})

	it("counts a mirrored value once, on its owner", () => {
		const rows: SettingsRow[] = [
			pref("subagents.default", "x", "y", { page: "subagents" }),
			pref("models.subagents", "x", "y", { page: "models", mirrorOf: "subagents.default" }),
		]
		expect(changedRows(rows, ctx).map((row) => row.id)).toEqual(["subagents.default"])
	})

	it("an explicit override equal to what it inherits is still changed", () => {
		const row = pref("models.temperature", 0.2, 0.2, { isOverride: () => true })
		expect(isRowChanged(row, ctx)).toBe(true)
	})

	it("an inherited value is not changed even when it differs from a stale default", () => {
		const row = pref("models.temperature", 0.5, 0.2, { isOverride: () => false })
		expect(isRowChanged(row, ctx)).toBe(false)
	})

	it("compares list values by what's in them", () => {
		expect(isRowChanged(pref("agent.list", ["a"], ["a"]), ctx)).toBe(false)
		expect(isRowChanged(pref("agent.list", ["a", "b"], ["a"]), ctx)).toBe(true)
	})

	it("leaves out rows behind a gate", () => {
		const rows: SettingsRow[] = [pref("debug.a", 1, 0, { page: "debug" })]
		expect(changedRows(rows, context({}, false))).toEqual([])
		expect(changedRows(rows, context({}, true))).toHaveLength(1)
	})

	it("leaves out a child of a hidden parent", () => {
		const rows: SettingsRow[] = [
			{ id: "agent.p", page: "agent", label: "p", kind: "state", visible: () => false },
			pref("agent.c", 1, 0, { parent: "agent.p" }),
		]
		expect(changedRows(rows, ctx)).toEqual([])
		expect(isRowVisible(rows, rows[1], ctx)).toBe(false)
	})
})

describe("Reset", () => {
	it("writes the default", () => {
		const row = pref("agent.a", 1, 0)
		resetRow([row], row, context())
		expect(row.write).toHaveBeenCalledWith(0, expect.anything())
	})

	it("uses the row's own reset when it has one", () => {
		const reset = vi.fn()
		const row = pref("agent.a", 1, 0, { reset })
		resetRow([row], row, context())
		expect(reset).toHaveBeenCalled()
		expect(row.write).not.toHaveBeenCalled()
	})

	it("a mirror resets its owner", () => {
		const owner = pref("subagents.default", "x", "y", { page: "subagents" })
		const mirror = pref("models.subagents", "x", "y", { page: "models", mirrorOf: owner.id })
		resetRow([owner, mirror], mirror, context())
		expect(owner.write).toHaveBeenCalledWith("y", expect.anything())
		expect(mirror.write).not.toHaveBeenCalled()
	})

	it("never touches a managed value", () => {
		const row = pref("data.a", 1, 0, { managedKeys: ["telemetrySetting"] })
		resetRow([row], row, context({ remoteConfigSettings: { telemetrySetting: "enabled" } }))
		expect(row.write).not.toHaveBeenCalled()
	})

	it("reports a failed write instead of throwing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const row = pref("agent.a", 1, 0, { write: () => Promise.reject(new Error("stale")) })
		resetRow([row], row, context())
		await vi.waitFor(() => expect(error).toHaveBeenCalled())
		error.mockRestore()
	})
})

describe("search", () => {
	const ctx = context()
	const ids = (query: string) => searchRows(SETTINGS_ROWS, query, ctx).map((row) => row.id)

	it("needs every word", () => {
		expect(ids("terminal reuse")).toEqual(["tools.terminal.reuse"])
	})

	it("matches aliases, page names and parent features", () => {
		expect(ids("telemetry")).toEqual(["data.reporting"])
		expect(ids("privacy")).toContain("data.reporting")
		expect(ids("toasts seconds")).toEqual(["layout.toasts.seconds"])
	})

	it("is empty for a blank query", () => {
		expect(ids("   ")).toEqual([])
	})

	it("walks up through nested parents", () => {
		const rows: SettingsRow[] = [
			{ id: "agent.a", page: "agent", label: "Alpha", kind: "state" },
			{ id: "agent.b", page: "agent", label: "Beta", kind: "state", parent: "agent.a" },
			{ id: "agent.c", page: "agent", label: "Gamma", kind: "state", parent: "agent.b" },
		]
		expect(rowAncestors(rows, rows[2]).map((row) => row.id)).toEqual(["agent.b", "agent.a"])
		expect(resolveShellTarget(rows, "agent.c", ctx)?.foldIds).toEqual(["agent.b", "agent.a"])
	})
})
