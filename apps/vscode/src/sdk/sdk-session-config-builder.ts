import type { CoreSessionConfig } from "@cline/core"
import type { ModelSettings } from "@shared/model-settings"
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
import { configuredProviderConfig, requestPolicyGuard } from "./model-settings/runtime-config"
import {
	captureThreadModelSelection,
	migrateThreadModelSelection,
	NextMessageModelSelections,
	resolveThreadPick,
	transientAdmission,
} from "./model-settings-resolver"
import { buildSubagentModelSettings } from "./subagent-profiles"

export interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
	emitHookMessage: HookMessageEmitter
	nextMessageSelections?: NextMessageModelSelections
	onConsecutiveMistakeLimitReached?: CoreSessionConfig["onConsecutiveMistakeLimitReached"]
}

/**
 * Ask-mode sessions (internal mode value "plan") get the shared read-only
 * investigation contract; the mode never instructs the model to switch modes
 * or produce a plan artifact.
 */
export class SdkSessionConfigBuilder {
	admission(config: object): (() => void) | undefined {
		return (config as { [transientAdmission]?: () => void })[transientAdmission]
	}

	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	async build(input: SessionConfigInput, threadId?: string): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
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
			const transient =
				threadId === undefined ? undefined : this.options.nextMessageSelections?.admission(threadId, input.mode ?? "act")
			const configuredProvider = await configuredProviderConfig(
				settings,
				transient?.pick ?? resolveThreadPick(thread, input.mode ?? "act"),
				modelAuthDependencies(state),
				{ state, mode: input.mode ?? "act" },
			)
			const config = Object.assign(await buildSessionConfig({ ...input, configuredProvider }), {
				apiSnapshot: { selection: { ...selection, modelSelectionV1: thread }, configuration: {} },
			})
			if (transient) Object.assign(config, { [transientAdmission]: transient.commit })
			config.enableSpawnAgent = settings.subagents.enabled
			const buildSubagents = (current: ModelSettings) =>
				buildSubagentModelSettings(current, async (modelId) => {
					const levels = current.models.find((row) => row.id === modelId)?.overrides.levels
					const provider = await configuredProviderConfig(
						current,
						{ modelId, levelId: levels && !levels.some((l) => l.id === "default") ? levels[0]!.id : "default" },
						modelAuthDependencies(state),
						{ state },
					)
					return {
						connection: {
							providerId: provider.providerId,
							modelId: provider.modelId!,
							apiKey: provider.apiKey,
							baseUrl: provider.baseUrl,
							headers: provider.headers,
							providerConfig: provider,
						},
						levels: provider.settingsModelLevels,
					}
				})
			config.subagentSettings = settings.subagents.enabled ? await buildSubagents(settings) : undefined
			if (this.options.onConsecutiveMistakeLimitReached)
				config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
			config.hooks = buildAgentHooks(state, this.options.emitHookMessage, input.cwd)
			const beforeModel = config.hooks.beforeModel
			config.hooks.beforeModel = async (ctx) => {
				await configuredProvider[requestPolicyGuard]?.()
				return beforeModel?.(ctx)
			}
			const beforeTool = config.hooks.beforeTool
			config.hooks.beforeTool = async (ctx) => {
				if (ctx.toolCall.toolName === "spawn_agent") {
					await configuredProvider[requestPolicyGuard]?.()
					const current = state.getGlobalStateKey("modelSettings")!
					if (!current.subagents.enabled) throw new Error("Subagents are turned off. Open Settings > Subagents.")
					// The spawn tool holds this policy object, so a call inside a running
					// turn is checked against today's settings and today's keys.
					const live = config.subagentSettings
					if (live?.modelPolicy) {
						const { modelPolicy, ...rest } = await buildSubagents(structuredClone(current))
						Object.assign(live, rest)
						Object.assign(live.modelPolicy, modelPolicy)
					}
				}
				return beforeTool?.(ctx)
			}
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
