import type { ModelInfo, OpenAiCompatibleModelInfo } from "@shared/api"
import type { ApiConfigProfile } from "@shared/api-profiles"
import { AssignApiProfileRequest } from "@shared/proto/cline/models"
import { isOpenaiReasoningEffort, type Mode, type OpenaiReasoningEffort } from "@shared/storage/types"
import { getModeSpecificFields, supportsReasoningEffortForModelId } from "@/components/settings/utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

export function assignedProfileId(
	mode: Mode,
	{ askProfileId, actProfileId }: { askProfileId?: string; actProfileId?: string },
): string | undefined {
	return mode === "plan" ? askProfileId : actProfileId
}

/** True when the selected model exposes any reasoning control the effort picker can drive. */
export function modelHasReasoning(modelId: string | undefined, modelInfo: ModelInfo | undefined): boolean {
	if (!modelInfo && !modelId) {
		return false
	}
	return (
		modelInfo?.supportsReasoning === true ||
		(modelInfo as OpenAiCompatibleModelInfo | undefined)?.supportsReasoningEffort === true ||
		modelInfo?.capabilities?.includes("reasoning") === true ||
		supportsReasoningEffortForModelId(modelId)
	)
}

export const formatEffort = (effort: string) =>
	effort === "none" ? "Provider default" : effort === "xhigh" ? "XHigh" : effort.charAt(0).toUpperCase() + effort.slice(1)

/** The effort chip's label: short enough for a narrow sidebar. The menu and tooltip keep {@link formatEffort}. */
export const formatEffortShort = (effort: string) =>
	effort === "none" ? "Default" : effort === "medium" ? "Med" : formatEffort(effort)

/**
 * Updates this chat's (or the next chat's) configuration for `mode` without touching Settings.
 * Shared by the configuration and effort pickers so both go through the same RPC.
 */
function useAssignApiProfile(mode: Mode) {
	const { currentTaskItem } = useExtensionState()
	return (changes: Partial<AssignApiProfileRequest>) =>
		void ModelsServiceClient.assignApiProfile(
			AssignApiProfileRequest.create({ mode, chatOverride: true, taskId: currentTaskItem?.id ?? "", ...changes }),
		).catch((error) => console.error("Failed to update chat configuration:", error))
}

/**
 * The saved configuration (API profile) for `mode` in this chat or the next-chat draft: which one is
 * picked, whether it is the default, and whether the running session still uses another one.
 */
export function useConfigSelection(mode: Mode, fallbackLabel: string) {
	const {
		apiConfigProfiles,
		askProfileId,
		actProfileId,
		apiConfiguration,
		composerApiSelection,
		composerNextMessageOnly,
		currentTaskItem,
		turnState,
		focusedSessionModels,
		navigateToSettings,
	} = useExtensionState()
	const update = useAssignApiProfile(mode)
	const profiles: ApiConfigProfile[] = apiConfigProfiles ?? []
	const defaults = {
		askProfileId,
		actProfileId,
		planModeReasoningEffort: apiConfiguration?.planModeReasoningEffort,
		actModeReasoningEffort: apiConfiguration?.actModeReasoningEffort,
	}
	const selection = composerApiSelection ?? defaults
	const currentId = assignedProfileId(mode, selection)
	const isDefault =
		currentId === assignedProfileId(mode, defaults) &&
		selection[`${mode}ModeReasoningEffort`] === defaults[`${mode}ModeReasoningEffort`]
	const busy = turnState?.phase === "streaming" || turnState?.phase === "awaiting_approval"
	const current = profiles.find((profile) => profile.id === currentId)
	const modeLabel = mode === "plan" ? "Ask" : "Act"
	// The home screen only marks the default; a non-default pick there needs no "next chat" label.
	const scopeLabel = composerNextMessageOnly ? "next message" : isDefault ? "default" : currentTaskItem ? "chat" : undefined
	const effective = focusedSessionModels?.[mode]
	const pending =
		!!effective &&
		!!current &&
		(effective.profileId !== current.id || effective.provider !== current.provider || effective.modelId !== current.modelId)
	const modelLabel = effective ? `${effective.provider}:${effective.modelId}` : `${current?.provider}:${current?.modelId}`

	return {
		profiles,
		current,
		modeLabel,
		/** The picker's label: the configuration's name, or the model when none is assigned. */
		label: current?.name ?? fallbackLabel,
		scopeLabel,
		pending,
		description: effective
			? `${modeLabel} currently uses ${modelLabel}${pending ? `; ${current?.name} change pending` : ""}`
			: current
				? `${modeLabel} uses ${current.name} (${modelLabel})`
				: "Open API settings",
		/** A next-message-only choice can't change while a turn runs. */
		locked: !!composerNextMessageOnly && busy,
		busy,
		hasChat: !!currentTaskItem,
		nextMessageOnly: !!composerNextMessageOnly,
		select: (profileId: string) => {
			if (profileId !== currentId) update({ profileId })
		},
		reset: () => update({ resetToDefault: true }),
		toggleNextMessageOnly: () => update({ nextMessageOnly: !composerNextMessageOnly }),
		manage: () => navigateToSettings("api-config"),
	}
}

interface EffortSelectionOptions {
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
}

/** The reasoning effort for `mode` in this chat; `available` is false for models without reasoning. */
export function useEffortSelection(mode: Mode, { modelId, modelInfo, defaultEffort = "none" }: EffortSelectionOptions) {
	const {
		apiConfiguration,
		askProfileId,
		actProfileId,
		composerApiSelection,
		composerNextMessageOnly,
		currentTaskItem,
		turnState,
		focusedSessionModels,
	} = useExtensionState()
	const update = useAssignApiProfile(mode)
	const busy = turnState?.phase === "streaming" || turnState?.phase === "awaiting_approval"
	const modeFields = getModeSpecificFields(apiConfiguration, mode)
	const storedEffort = composerApiSelection ? composerApiSelection[`${mode}ModeReasoningEffort`] : modeFields.reasoningEffort
	const profileAssigned =
		mode === "plan"
			? (composerApiSelection?.askProfileId ?? askProfileId)
			: (composerApiSelection?.actProfileId ?? actProfileId)
	const selected: OpenaiReasoningEffort = isOpenaiReasoningEffort(storedEffort)
		? storedEffort
		: profileAssigned
			? "none"
			: defaultEffort
	const effective = focusedSessionModels?.[mode]
	const pending = !!effective && (effective.reasoningEffort ?? "none") !== selected

	return {
		available: modelHasReasoning(modelId, modelInfo),
		selected,
		pending,
		description: pending
			? `Currently uses ${formatEffort(effective?.reasoningEffort ?? "none")}; change pending`
			: `Reasoning effort: ${formatEffort(selected)}`,
		/** A next-message-only choice can't change while a turn runs. */
		locked: !!composerNextMessageOnly && busy,
		busy,
		hasChat: !!currentTaskItem,
		nextMessageOnly: !!composerNextMessageOnly,
		select: (effort: OpenaiReasoningEffort) => {
			if (effort !== selected) update({ reasoningEffort: effort })
		},
		reset: () => update({ resetToDefault: true }),
		toggleNextMessageOnly: () => update({ nextMessageOnly: !composerNextMessageOnly }),
	}
}
