import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import { approvesWithoutAsking, buildToolPolicies, isToolAutoApproved } from "./sdk-tool-policies"

describe("isToolAutoApproved", () => {
	it("enables and auto-approves notebook staging independently of workspace editing settings", () => {
		expect(buildToolPolicies(DEFAULT_AUTO_APPROVAL_SETTINGS).notebook).toEqual({ enabled: true, autoApprove: true })
		expect(isToolAutoApproved("notebook", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(true)
	})
	it("does not auto-approve command tools by default", () => {
		expect(isToolAutoApproved("run_commands", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(false)
	})

	it("uses executeSafeCommands as the single command approval flag", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				executeSafeCommands: false,
				executeAllCommands: true,
			},
		}

		expect(isToolAutoApproved("run_commands", settings)).toBe(false)
	})

	it("auto-approves all MCP tools when the Use MCP servers toggle is on", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: true },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(true)
	})

	it("prompts for MCP tools when the Use MCP servers toggle is off", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: false },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(false)
	})
})

describe("approvesWithoutAsking across workspace folders", () => {
	const settings = DEFAULT_AUTO_APPROVAL_SETTINGS
	// Stands in for the real-path check: the edit's real location is inside /ws/two only.
	const approveInside = (root: string) => root === "/ws/two"

	it("lets a thread in one folder of a multi-root workspace edit another folder", () => {
		expect(
			approvesWithoutAsking("editor", { settings, cwd: "/ws/one", workspaceRoots: ["/ws/one", "/ws/two"], approveInside }),
		).toBe(true)
	})

	it("keeps a thread in its own worktree to that worktree", () => {
		expect(
			approvesWithoutAsking("editor", {
				settings,
				cwd: "/ws/one/.worktrees/t1",
				workspaceRoots: ["/ws/one", "/ws/two"],
				approveInside,
			}),
		).toBe(false)
	})

	it("keeps an automation step to its worktree even if that is a workspace folder", () => {
		expect(
			approvesWithoutAsking("editor", {
				settings,
				cwd: "/ws/one",
				confined: true,
				workspaceRoots: ["/ws/one", "/ws/two"],
				approveInside,
			}),
		).toBe(false)
	})
})
