import type { CoreSessionConfig } from "@cline/core"
import {
	captureTaskApiSelection,
	cloneApiProfileConfiguration,
	resolveApiConfigurationForTaskSelection,
} from "@/core/controller/models/apiProfiles"
import type { StateManager } from "@/core/storage/StateManager"
import { buildSessionConfig, type SessionConfigInput } from "./cline-session-factory"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"
import { modelAuthDependencies } from "./model-settings/auth-dependencies"
import { modelSettingsRolloutEnabled } from "./model-settings/rollout"
import { configuredProviderConfig } from "./model-settings/runtime-config"
import { captureThreadModelSelection, migrateThreadModelSelection, resolveThreadPick } from "./model-settings-resolver"

export interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
	emitHookMessage: HookMessageEmitter
	onConsecutiveMistakeLimitReached?: CoreSessionConfig["onConsecutiveMistakeLimitReached"]
}

/**
 * Ask-mode sessions (internal mode value "plan") get the shared read-only
 * investigation contract; the mode never instructs the model to switch modes
 * or produce a plan artifact.
 */
export class SdkSessionConfigBuilder {
	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	async build(input: SessionConfigInput): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
		// Capture both before the builder's first await. Focus changes cannot split
		// the picker selection from the credentials/model used to build the session.
		const selection = structuredClone(input.apiSelection ?? captureTaskApiSelection(this.options.stateManager))
		const journal = this.options.stateManager.getGlobalStateKey("modelSettingsMigration")
		if (modelSettingsRolloutEnabled() && journal?.status === "complete") {
			const state = this.options.stateManager
			const settings = structuredClone(state.getGlobalStateKey("modelSettings")!)
			const thread =
				selection.modelSelectionV1 ??
				(input.apiSelection ? migrateThreadModelSelection(selection, journal) : captureThreadModelSelection(settings))
			if (!state.connectionSecrets) throw new Error("Connection keychain is unavailable")
			const configuredProvider = await configuredProviderConfig(
				settings,
				resolveThreadPick(thread, input.mode ?? "act"),
				modelAuthDependencies(state),
			)
			const config = Object.assign(await buildSessionConfig({ ...input, configuredProvider }), {
				apiSnapshot: { selection: { ...selection, modelSelectionV1: thread }, configuration: {} },
			})
			if (this.options.onConsecutiveMistakeLimitReached)
				config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
			config.hooks = buildAgentHooks(state, this.options.emitHookMessage, input.cwd)
			return config
		}
		const configuration = cloneApiProfileConfiguration(
			input.apiConfiguration ??
				resolveApiConfigurationForTaskSelection(
					this.options.stateManager,
					this.options.stateManager.getApiConfiguration(input.mode ?? "act"),
					input.mode ?? "act",
					selection,
				),
		)
		const snapshot = { selection, configuration: structuredClone(configuration) }
		const config = Object.assign(await buildSessionConfig({ ...input, apiConfiguration: configuration }), {
			apiSnapshot: snapshot,
		})
		if (this.options.onConsecutiveMistakeLimitReached) {
			config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
		}

		config.hooks = buildAgentHooks(this.options.stateManager, this.options.emitHookMessage, input.cwd)

		return config
	}
}
