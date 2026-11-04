import type { ModelPick } from "@shared/model-settings"
import { useCallback, useEffect, useState } from "react"
import ClineLogoWhite from "@/assets/ClineLogoWhite"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { selectorDataFromModelSettings } from "../models/modelSelectorRows"
import { MigrationFailedNotice, MigrationPending } from "../settings/about/MigrationNotices"
import { modelSettingsClient as client } from "../settings/models/modelSettingsClient"
import { SettingsShell } from "../settings/shell/SettingsShell"

const ONBOARDING_PAGE = "byok_provider_config"

const noop = () => {}

/**
 * Fork onboarding (plan §1b): there is no hosted-account path. It's the Models page with one way out: the
 * person sets up a model, and whatever they haven't picked runs on the first one they added.
 */
const OnboardingView = () => {
	const { hideAccount, hideSettings, modelSettings, modelSettingsMigrationStatus, setShowWelcome } = useExtensionState()
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState<string>()

	useEffect(() => {
		StateServiceClient.captureOnboardingProgress({
			step: 0,
			action: "page_viewed",
			page: ONBOARDING_PAGE,
		})
	}, [])

	const finish = useCallback(async () => {
		setIsSaving(true)
		setError(undefined)
		try {
			const state = await client.get()
			const { rows } = selectorDataFromModelSettings(state)
			const first = rows.find((row) => !row.disabledReason) ?? rows[0]
			const { roles } = state.settings
			const pick: ModelPick | null = first && { modelId: first.id, levelId: first.defaultLevelId ?? "default" }
			const chat = roles.chat ?? pick
			const background = roles.background.pick ?? chat
			const ask = roles.ask.enabled ? (roles.ask.pick ?? chat) : roles.ask.pick
			if (chat !== roles.chat || background !== roles.background.pick || ask !== roles.ask.pick) {
				await client.setRoles(state.settings.revision, {
					...roles,
					chat,
					ask: { ...roles.ask, pick: ask },
					background: { ...roles.background, pick: background },
				})
			}
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
			setError(err instanceof Error ? err.message : "Failed to save your model.")
		} finally {
			setIsSaving(false)
		}
	}, [hideAccount, hideSettings, setShowWelcome])

	if (!modelSettings) {
		return (
			<div className="fixed inset-0 flex flex-col items-center justify-center gap-4 overflow-auto px-5">
				<ClineLogoWhite className="size-16 shrink-0" />
				<div className="w-full max-w-lg">
					{modelSettingsMigrationStatus?.status === "failed" ? (
						<MigrationFailedNotice status={modelSettingsMigrationStatus} />
					) : (
						<MigrationPending />
					)}
				</div>
			</div>
		)
	}

	const hasModel = modelSettings.settings.models.length > 0
	return (
		<SettingsShell
			onDone={noop}
			setupIntro={
				<div className="flex items-center gap-3 border-b border-editor-group-border px-3 py-2.5">
					<ClineLogoWhite className="size-8 shrink-0" />
					<div className="min-w-0 flex-1">
						<h2 className="m-0 text-sm font-semibold">Set up your first model</h2>
						<p className="m-0 text-[11.5px] text-description">
							It runs your chats and background text. You can change this later in Settings.
						</p>
						{error && (
							<p className="m-0 text-[11.5px] text-error" role="alert">
								{error}
							</p>
						)}
					</div>
					<Button
						disabled={!hasModel || isSaving}
						onClick={() => void finish()}
						size="sm"
						title={hasModel ? undefined : "Add a model first"}>
						{isSaving ? "Saving…" : "Continue"}
					</Button>
				</div>
			}
		/>
	)
}

export default OnboardingView
