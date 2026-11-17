import type { TaskApiSelection } from "@shared/api-profiles"
import type { ExtensionState } from "@shared/ExtensionMessage"
import type { SessionApiSnapshot } from "@/sdk/cline-session-factory"
import type { ApiConfiguration, ApiProvider } from "@/shared/api"
import { getProviderDefaultModelId, getProviderModelIdKey } from "@/shared/storage/provider-keys"
import type { Mode } from "@/shared/storage/types"

type TaskApiModel = {
	getModel: () => { id: string }
}

function readString(config: ApiConfiguration, key: keyof ApiConfiguration): string | undefined {
	const value = config[key]
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export function resolveActiveModelIdFromApiConfiguration(config: ApiConfiguration, mode: Mode): string {
	const provider = mode === "plan" ? config.planModeApiProvider : config.actModeApiProvider
	const genericModelKey = mode === "plan" ? "planModeApiModelId" : "actModeApiModelId"

	if (provider) {
		const providerModelKey = getProviderModelIdKey(provider as ApiProvider, mode) as keyof ApiConfiguration
		return (
			readString(config, providerModelKey) ??
			readString(config, genericModelKey) ??
			getProviderDefaultModelId(provider as ApiProvider) ??
			"unknown"
		)
	}

	return readString(config, genericModelKey) ?? "unknown"
}

/** The model each mode of a live session runs, as the composer and context ring show it. */
export function focusedModelsFromSnapshot(
	snapshot: SessionApiSnapshot | undefined,
	selection: TaskApiSelection | undefined,
): ExtensionState["focusedSessionModels"] {
	if (snapshot?.configuredModel) {
		const { mode, ...model } = snapshot.configuredModel
		return { [mode]: model }
	}
	const configuration = snapshot?.configuration
	if (!configuration) return undefined
	return Object.fromEntries(
		(["plan", "act"] as const).map((mode) => [
			mode,
			{
				profileId: mode === "plan" ? selection?.askProfileId : selection?.actProfileId,
				provider: configuration[`${mode}ModeApiProvider`],
				modelId: resolveActiveModelIdFromApiConfiguration(configuration, mode),
				reasoningEffort: configuration[`${mode}ModeReasoningEffort`],
			},
		]),
	)
}

export function createTaskApiModelShim(modelId: string): TaskApiModel {
	return {
		getModel: () => ({ id: modelId }),
	}
}
