import type { ApiConfigProfile } from "@shared/api-profiles"
import { AssignApiProfileRequest } from "@shared/proto/cline/models"
import type { Mode } from "@shared/storage/types"
import { memo } from "react"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

/** Sentinel value for the "Manage configurations…" entry; never assigned. */
export const MANAGE_CONFIGURATIONS_VALUE = "__manage_configurations__"

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
 * Picking one assigns it to the mode; "Manage configurations…" opens the API
 * settings tab.
 */
const ConfigPicker = ({ mode, fallbackLabel }: ConfigPickerProps) => {
	const { apiConfigProfiles, askProfileId, actProfileId, navigateToSettings } = useExtensionState()
	const profiles: ApiConfigProfile[] = apiConfigProfiles ?? []
	const currentId = assignedProfileId(mode, { askProfileId, actProfileId })
	const current = profiles.find((profile) => profile.id === currentId)
	const modeLabel = mode === "plan" ? "Ask" : "Act"

	return (
		<Select
			onValueChange={(value) => {
				if (value === MANAGE_CONFIGURATIONS_VALUE) {
					navigateToSettings("api-config")
					return
				}
				if (value === currentId) {
					return
				}
				void ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode, profileId: value })).catch(
					(error) => console.error("Failed to assign configuration:", error),
				)
			}}
			value={current?.id ?? ""}>
			<SelectTrigger
				aria-label={`${modeLabel} configuration`}
				className="h-5 min-w-0 max-w-40 shrink gap-0.5 rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description shadow-none hover:text-foreground focus-visible:ring-0 data-[size=default]:h-5 [&_svg]:size-2.5"
				data-testid="config-picker"
				title={
					current ? `${modeLabel} uses ${current.name} (${current.provider}:${current.modelId})` : "Open API settings"
				}>
				<SelectValue placeholder={fallbackLabel}>
					<span className="truncate">{current?.name ?? fallbackLabel}</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="start" className="menu-rise" side="top">
				{profiles.map((profile) => (
					<SelectItem className="text-xs" key={profile.id} value={profile.id}>
						<span className="truncate">{profile.name}</span>
					</SelectItem>
				))}
				{profiles.length > 0 && <SelectSeparator />}
				<SelectItem className="text-xs text-description" value={MANAGE_CONFIGURATIONS_VALUE}>
					Manage configurations…
				</SelectItem>
			</SelectContent>
		</Select>
	)
}

export default memo(ConfigPicker)
