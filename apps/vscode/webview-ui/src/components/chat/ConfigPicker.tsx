import type { ApiConfigProfile } from "@shared/api-profiles"
import { AssignApiProfileRequest } from "@shared/proto/cline/models"
import type { Mode } from "@shared/storage/types"
import { memo } from "react"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

/** Sentinel value for the "Manage configurations…" entry; never assigned. */
export const MANAGE_CONFIGURATIONS_VALUE = "__manage_configurations__"
export const RESET_CONFIGURATION_VALUE = "__reset_configuration__"
export const NEXT_MESSAGE_VALUE = "__next_message__"

export function assignedProfileId(
	mode: Mode,
	{ askProfileId, actProfileId }: { askProfileId?: string; actProfileId?: string },
): string | undefined {
	return mode === "plan" ? askProfileId : actProfileId
}

interface ConfigPickerProps {
	mode: Mode
	/** Shown when no saved configuration is assigned (e.g. before any exist). */
	fallbackLabel: string
}

/**
 * Bottom-bar picker listing saved configuration names for the current mode.
 * Picking one overrides this chat or the next-chat draft; "Manage configurations…" opens the API
 * settings tab.
 */
const ConfigPicker = ({ mode, fallbackLabel }: ConfigPickerProps) => {
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
	const update = (changes: Partial<AssignApiProfileRequest>) =>
		void ModelsServiceClient.assignApiProfile(
			AssignApiProfileRequest.create({ mode, chatOverride: true, taskId: currentTaskItem?.id ?? "", ...changes }),
		).catch((error) => console.error("Failed to update chat configuration:", error))
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

	return (
		<Select
			disabled={!!composerNextMessageOnly && busy}
			onValueChange={(value) => {
				if (value === MANAGE_CONFIGURATIONS_VALUE) {
					navigateToSettings("api-config")
					return
				}
				if (value === RESET_CONFIGURATION_VALUE) {
					update({ resetToDefault: true })
					return
				}
				if (value === NEXT_MESSAGE_VALUE) {
					update({ nextMessageOnly: !composerNextMessageOnly })
					return
				}
				if (value === currentId) {
					return
				}
				update({ profileId: value })
			}}
			value={current?.id ?? ""}>
			<SelectTrigger
				aria-label={`${modeLabel} configuration`}
				className="h-5 min-w-0 max-w-40 shrink gap-0.5 rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description shadow-none hover:text-foreground focus-visible:ring-0 data-[size=default]:h-5 [&_svg]:size-2.5"
				data-testid="config-picker"
				title={
					effective
						? `${modeLabel} currently uses ${modelLabel}${pending ? `; ${current?.name} change pending` : ""}`
						: current
							? `${modeLabel} uses ${current.name} (${modelLabel})`
							: "Open API settings"
				}>
				<SelectValue placeholder={fallbackLabel}>
					<span className="truncate">
						{current?.name ?? fallbackLabel}
						{pending ? " (pending)" : ""}
						{scopeLabel && <span className="ml-1 opacity-60">{scopeLabel}</span>}
					</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="start" className="menu-rise" side="top">
				{profiles.map((profile) => (
					<SelectItem className="text-xs" key={profile.id} value={profile.id}>
						<span className="truncate">{profile.name}</span>
					</SelectItem>
				))}
				{profiles.length > 0 && <SelectSeparator />}
				<SelectItem className="text-xs text-description" value={RESET_CONFIGURATION_VALUE}>
					Reset to default
				</SelectItem>
				{currentTaskItem && (
					<SelectItem className="text-xs text-description" disabled={busy} value={NEXT_MESSAGE_VALUE}>
						{composerNextMessageOnly ? "Keep for this chat" : "Use next choice for next message only"}
					</SelectItem>
				)}
				<SelectItem className="text-xs text-description" value={MANAGE_CONFIGURATIONS_VALUE}>
					Manage configurations…
				</SelectItem>
			</SelectContent>
		</Select>
	)
}

export default memo(ConfigPicker)
