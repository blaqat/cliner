import { BooleanRequest } from "@shared/proto/cline/common"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { TERMINAL_ENV_UNCHANGED, type TerminalEnvironmentSettings } from "@shared/terminal-environment"
import { describe, expect, it, vi } from "vitest"
import { getStateToPostToWebview } from "./getStateToPostToWebview"
import { revealTerminalEnvironment } from "./revealTerminalEnvironment"
import { updateSettings } from "./updateSettings"

vi.mock("@/config", () => ({ ClineEnv: { config: () => ({ environment: "test" }) } }))
vi.mock("@/registry", () => ({ ExtensionRegistryInfo: { version: "test" } }))
vi.mock("@/services/banner/BannerService", () => ({
	BannerService: { get: () => ({ getActiveBanners: () => [], getWelcomeBanners: () => [] }) },
}))
vi.mock("@/services/feature-flags", () => ({ featureFlagsService: { getWorktreesEnabled: () => false } }))
vi.mock("@/services/logging/distinctId", () => ({ getDistinctId: () => "test" }))
vi.mock("@/services/telemetry/rollout-metadata", () => ({ getExtensionVariant: () => "test" }))
vi.mock("@/utils/announcements", () => ({ getLatestAnnouncementId: () => "test" }))
vi.mock("@core/hooks/hooks-utils", () => ({ getHooksEnabledSafe: () => false }))
vi.mock("../models/getClineOnboardingModels", () => ({ getClineOnboardingModels: () => [] }))
vi.mock("@/integrations/openai-codex/oauth", () => ({ openAiCodexOAuthManager: { isAuthenticated: async () => false } }))

function makeController(initial: { global?: TerminalEnvironmentSettings; workspace?: TerminalEnvironmentSettings } = {}) {
	const state: Record<string, TerminalEnvironmentSettings | undefined> = {
		global: initial.global,
		workspace: initial.workspace,
	}
	const stateManager = {
		getApiConfiguration: () => ({}),
		getGlobalStateKey: (key: string) => (key === "terminalEnvironment" ? state.global : undefined),
		getGlobalSettingsKey: () => undefined,
		getWorkspaceStateKey: (key: string) => (key === "terminalEnvironment" ? state.workspace : undefined),
		setGlobalState: vi.fn((_key: string, value: TerminalEnvironmentSettings) => {
			state.global = value
		}),
		setWorkspaceState: vi.fn((_key: string, value: TerminalEnvironmentSettings) => {
			state.workspace = value
		}),
	}
	return { stateManager, state, postStateToWebview: vi.fn().mockResolvedValue(undefined) }
}

describe("terminal environment state", () => {
	it("posts variable names with masked placeholders, never values", async () => {
		const controller = makeController({
			global: { variables: { GITHUB_TOKEN: "ghp_secret" }, envFilePath: "/tmp/x.env" },
			workspace: { variables: { NODE_ENV: "s3cret-ws" } },
		})
		const state = await getStateToPostToWebview(controller as never)
		expect(state.terminalEnvironment?.global.variables).toEqual({ GITHUB_TOKEN: TERMINAL_ENV_UNCHANGED })
		expect(state.terminalEnvironment?.global.envFilePath).toBe("/tmp/x.env")
		expect(state.terminalEnvironment?.workspace.variables).toEqual({ NODE_ENV: TERMINAL_ENV_UNCHANGED })
		const serialized = JSON.stringify(state)
		expect(serialized).not.toContain("ghp_secret")
		expect(serialized).not.toContain("s3cret-ws")
	})

	it("reveals the values of exactly the requested scope", async () => {
		const controller = makeController({
			global: { variables: { G: "global-value" } },
			workspace: { variables: { W: "workspace-value" } },
		})
		const global = await revealTerminalEnvironment(controller as never, BooleanRequest.create({ value: false }))
		expect(global.variables).toEqual({ G: "global-value" })
		const workspace = await revealTerminalEnvironment(controller as never, BooleanRequest.create({ value: true }))
		expect(workspace.variables).toEqual({ W: "workspace-value" })
	})

	it("applies back-to-back patches (save then remove) against the freshest stored value", async () => {
		const controller = makeController({ global: { variables: { A: "1", B: "2" } } })
		await updateSettings(
			controller as never,
			UpdateSettingsRequest.create({
				terminalEnvironment: {
					workspace: false,
					setVariables: { A: "new" },
					removeVariables: [],
					addPathEntries: [],
					removePathEntries: [],
				},
			}),
		)
		await updateSettings(
			controller as never,
			UpdateSettingsRequest.create({
				terminalEnvironment: {
					workspace: false,
					setVariables: {},
					removeVariables: ["B"],
					addPathEntries: [],
					removePathEntries: [],
				},
			}),
		)
		expect(controller.state.global?.variables).toEqual({ A: "new" })
		expect(controller.stateManager.setWorkspaceState).not.toHaveBeenCalled()
	})

	it("leaves untouched stored secrets alone when a patch carries the sentinel", async () => {
		const controller = makeController({ workspace: { variables: { TOKEN: "keep-me" } } })
		await updateSettings(
			controller as never,
			UpdateSettingsRequest.create({
				terminalEnvironment: {
					workspace: true,
					setVariables: { TOKEN: TERMINAL_ENV_UNCHANGED, OTHER: "x" },
					removeVariables: [],
					addPathEntries: [],
					removePathEntries: [],
				},
			}),
		)
		expect(controller.state.workspace?.variables).toEqual({ TOKEN: "keep-me", OTHER: "x" })
	})
})
