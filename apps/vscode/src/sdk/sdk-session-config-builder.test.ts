import { describe, expect, it, vi } from "vitest"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"

const mocks = vi.hoisted(() => ({
	buildSessionConfig: vi.fn(),
	buildAgentHooks: vi.fn(() => ({})),
}))

vi.mock("./cline-session-factory", () => ({
	buildSessionConfig: mocks.buildSessionConfig,
}))

vi.mock("./hooks-adapter", () => ({
	buildAgentHooks: mocks.buildAgentHooks,
}))

describe("SdkSessionConfigBuilder", () => {
	it("captures connection data and selection together before asynchronous configuration building", async () => {
		let selected = "P"
		const configuration = {
			actModeApiProvider: "openai",
			actModeOpenAiModelId: "p-model",
			openAiApiKey: "p-secret",
			actModeReasoningEffort: "low",
		}
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		mocks.buildSessionConfig.mockImplementationOnce(async () => {
			await gate
			return { providerId: "openai", modelId: "p-model" }
		})
		const builder = new SdkSessionConfigBuilder({
			stateManager: {
				getGlobalStateKey: (key: string) => (key === "apiConfigProfiles" ? [] : selected),
				getApiConfiguration: () => configuration,
			} as never,
			emitHookMessage: vi.fn(),
		})
		const building = builder.build({ cwd: "/workspace", mode: "act" })
		selected = "Q"
		configuration.openAiApiKey = "q-secret"
		release()
		const config = await building
		expect((config as unknown as { apiSnapshot: unknown }).apiSnapshot).toMatchObject({
			selection: { actProfileId: "P", actModeReasoningEffort: "low" },
			configuration: { openAiApiKey: "p-secret", actModeOpenAiModelId: "p-model" },
		})
	})

	it("never exposes a switch_to_act_mode tool, even in plan mode", async () => {
		// Matches the legacy extension: the model cannot switch plan -> act
		// itself; the user must flip the Plan/Act toggle.
		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalStateKey: () => undefined, getApiConfiguration: () => ({}) } as never,
			emitHookMessage: vi.fn(),
		})

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const planConfig = await builder.build({ cwd: "/workspace", mode: "plan" })
		expect(planConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const actConfig = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(actConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)
	})

	it("wires the agent hooks into the SDK config", async () => {
		const hooks = { beforeModel: vi.fn() }
		mocks.buildAgentHooks.mockReturnValueOnce(hooks)
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })

		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalStateKey: () => undefined, getApiConfiguration: () => ({}) } as never,
			emitHookMessage: vi.fn(),
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(config.hooks).toBe(hooks)
	})

	it("passes the mistake-limit callback into the SDK config without overriding SDK execution defaults", async () => {
		const onConsecutiveMistakeLimitReached = vi.fn()
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, execution: { maxRetries: 1 } })

		const builder = new SdkSessionConfigBuilder({
			stateManager: {
				getGlobalSettingsKey: vi.fn(() => 3),
				getGlobalStateKey: () => undefined,
				getApiConfiguration: () => ({}),
			} as never,
			emitHookMessage: vi.fn(),
			onConsecutiveMistakeLimitReached,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(config.execution).toEqual({ maxRetries: 1 })
		expect(config.onConsecutiveMistakeLimitReached).toBe(onConsecutiveMistakeLimitReached)
	})
})
