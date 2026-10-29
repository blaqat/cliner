import { type AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import {
	applyPermissionPreset,
	approvalActionIds,
	matchPermissionPreset,
	PERMISSION_PRESETS,
	summarizeApprovals,
} from "./permissionPresets"

const withActions = (actions: Partial<AutoApprovalSettings["actions"]>): AutoApprovalSettings => ({
	...DEFAULT_AUTO_APPROVAL_SETTINGS,
	actions: {
		readFiles: false,
		editFiles: false,
		executeSafeCommands: false,
		useBrowser: false,
		useMcp: false,
		...actions,
	},
})

describe("permission presets", () => {
	it("are Ask first, Edit files, Safe commands and Full access, least to most trust", () => {
		expect(PERMISSION_PRESETS.map((preset) => preset.name)).toEqual([
			"Ask first",
			"Edit files",
			"Safe commands",
			"Full access",
		])
		// Each preset includes everything the previous one allows.
		for (let i = 1; i < PERMISSION_PRESETS.length; i++) {
			expect(PERMISSION_PRESETS[i].on).toEqual(expect.arrayContaining([...PERMISSION_PRESETS[i - 1].on]))
		}
	})

	it.each([
		[{}, "ask"],
		[{ readFiles: true, editFiles: true }, "edit"],
		[{ readFiles: true, editFiles: true, executeSafeCommands: true, useBrowser: true }, "commands"],
		[{ readFiles: true, editFiles: true, executeSafeCommands: true, useBrowser: true, useMcp: true }, "full"],
	] as const)("maps %o onto the %s preset", (actions, id) => {
		expect(matchPermissionPreset(withActions(actions))?.id).toBe(id)
	})

	it("is Custom (no preset) for any other mix, like the shipped defaults", () => {
		// Defaults: read, edit, web fetch and MCP on; commands off.
		expect(matchPermissionPreset(DEFAULT_AUTO_APPROVAL_SETTINGS)).toBeUndefined()
		expect(matchPermissionPreset(withActions({ readFiles: true }))).toBeUndefined()
		expect(matchPermissionPreset(withActions({ useMcp: true }))).toBeUndefined()
		expect(summarizeApprovals(DEFAULT_AUTO_APPROVAL_SETTINGS)).toEqual({ enabledCount: 4, total: 5, approveAll: false })
	})

	it("ignores the legacy fields the list doesn't show", () => {
		expect(matchPermissionPreset(withActions({ readFiles: true, editFiles: true, executeAllCommands: true }))?.id).toBe(
			"edit",
		)
	})

	it("applies a preset onto exactly the listed approval types, bumping the version and keeping the rest", () => {
		const before = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, version: 7, enableNotifications: true }
		const next = applyPermissionPreset(before, "commands")
		expect(next.version).toBe(8)
		expect(next.enableNotifications).toBe(true)
		expect(next.actions).toMatchObject({
			readFiles: true,
			editFiles: true,
			executeSafeCommands: true,
			useBrowser: true,
			useMcp: false,
			// Legacy fields stay as they were.
			executeAllCommands: true,
			readFilesExternally: true,
		})
		expect(matchPermissionPreset(next)?.id).toBe("commands")
		for (const preset of PERMISSION_PRESETS) {
			expect(matchPermissionPreset(applyPermissionPreset(before, preset.id))?.id).toBe(preset.id)
		}
	})

	it("counts every listed approval type and calls all of them on approve-all", () => {
		expect(approvalActionIds()).toEqual(["readFiles", "editFiles", "executeSafeCommands", "useBrowser", "useMcp"])
		expect(summarizeApprovals(applyPermissionPreset(DEFAULT_AUTO_APPROVAL_SETTINGS, "full")).approveAll).toBe(true)
		expect(summarizeApprovals(undefined)).toEqual({ enabledCount: 0, total: 5, approveAll: false })
	})
})
