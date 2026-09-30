import type { CoreSessionConfig } from "@cline/core"
import { captureTaskApiSelection, cloneApiProfileConfiguration } from "@/core/controller/models/apiProfiles"
import type { StateManager } from "@/core/storage/StateManager"
import { buildSessionConfig, type SessionConfigInput } from "./cline-session-factory"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"

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
		const configuration = cloneApiProfileConfiguration(
			input.apiConfiguration ?? this.options.stateManager.getApiConfiguration(input.mode ?? "act"),
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
