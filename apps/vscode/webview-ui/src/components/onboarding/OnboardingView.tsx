import { AssignApiProfileRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { AlertCircleIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import ClineLogoWhite from "@/assets/ClineLogoWhite"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import ApiProfileEditor from "../settings/apiProfiles/ApiProfileEditor"
import {
	buildSaveRequest,
	newProfileDraft,
	PROVIDER_LABELS,
	type ProfileDraft,
	validateProfileDraftConfig,
} from "../settings/apiProfiles/profileDraft"

const ONBOARDING_PAGE = "byok_provider_config"

/**
 * Fork onboarding (plan §1b): there is no hosted-account path — the user
 * configures one of the allowed providers, which is saved as an API
 * configuration and assigned to both Ask and Act.
 */
const OnboardingView = () => {
	const { hideAccount, hideSettings, setShowWelcome } = useExtensionState()
	const [draft, setDraft] = useState<ProfileDraft>(() => ({
		...newProfileDraft(),
		name: PROVIDER_LABELS[newProfileDraft().provider],
	}))
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)

	useEffect(() => {
		StateServiceClient.captureOnboardingProgress({
			step: 0,
			action: "page_viewed",
			page: ONBOARDING_PAGE,
		})
	}, [])

	const onDraftChange = useCallback((next: ProfileDraft) => {
		setDraft((current) => {
			// Keep the auto-seeded name tracking the provider until the user types one.
			if (next.provider !== current.provider) {
				const previousLabel = PROVIDER_LABELS[current.provider]
				if (!next.name.trim() || next.name === previousLabel) {
					next = { ...next, name: PROVIDER_LABELS[next.provider] ?? next.name }
				}
			}
			return next
		})
		setError(undefined)
	}, [])

	const complete = useCallback(
		async (next: ProfileDraft) => {
			const configError = validateProfileDraftConfig(next)
			if (configError) {
				setError(configError)
				return
			}
			setIsSaving(true)
			setError(undefined)
			try {
				const response = await ModelsServiceClient.saveApiProfile(buildSaveRequest(next))
				const profileId = response.profile?.id
				if (!profileId) {
					throw new Error("The configuration was not saved.")
				}
				// Ask and Act share the saved configuration created here.
				await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ planActSeparateModelsSetting: true }))
				await Promise.all([
					ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode: "plan", profileId })),
					ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode: "act", profileId })),
				])
				await StateServiceClient.setWelcomeViewCompleted({ value: true }).catch(() => {})
				setShowWelcome(false)
				hideAccount()
				hideSettings()
				StateServiceClient.captureOnboardingProgress({
					step: 0,
					action: "completed",
					page: ONBOARDING_PAGE,
					userType: "byok",
					completed: true,
				})
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to save configuration.")
			} finally {
				setIsSaving(false)
			}
		},
		[hideAccount, hideSettings, setShowWelcome],
	)

	return (
		<div className="fixed inset-0 p-0 flex flex-col w-full">
			<div className="h-full px-5 xs:mx-10 overflow-auto flex flex-col gap-4 items-center justify-center">
				<ClineLogoWhite className="size-16 flex-shrink-0" />
				<h2 className="text-lg font-semibold p-0 flex-shrink-0">Configure your provider</h2>
				<p className="text-foreground text-sm text-center m-0 p-0 flex-shrink-0">
					Create an API configuration to get started. It is used for both Ask and Act.
				</p>

				<div className="flex-1 w-full flex max-w-lg overflow-y-auto min-h-0">
					<div className="w-full my-4">
						<ApiProfileEditor
							assignedModes={[]}
							draft={draft}
							error={error}
							isSaving={isSaving}
							onChange={onDraftChange}
							onSave={complete}
						/>
					</div>
				</div>

				<footer className="flex w-full max-w-lg flex-col gap-3 my-2 px-2 overflow-hidden flex-shrink-0">
					<div className="items-center justify-center flex text-sm text-foreground gap-2 mb-3 text-pretty">
						<AlertCircleIcon className="shrink-0 size-2" /> You can change this later in settings
					</div>
				</footer>
			</div>
		</div>
	)
}

export default OnboardingView
