import type { OpenAiCompatibleApiType } from "@shared/api-profiles"
import { EmptyRequest } from "@shared/proto/cline/common"
import { DeleteApiProfileRequest } from "@shared/proto/cline/models"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import ApiProfileEditor from "./ApiProfileEditor"
import {
	buildSaveRequest,
	describeProfile,
	draftFromProto,
	duplicateDraft,
	newProfileDraft,
	type ProfileDraft,
} from "./profileDraft"

const ApiProfilesPanel = () => {
	const { apiConfigProfiles, profiles: namedProfiles } = useExtensionState()
	const [draft, setDraft] = useState<ProfileDraft | undefined>(undefined)
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)

	const profiles = apiConfigProfiles ?? []
	// Profiles (Settings › Profiles) run on these configurations; one in use cannot be deleted.
	const profilesUsing = (configurationId: string | undefined) =>
		configurationId
			? (namedProfiles ?? [])
					.filter((profile) => profile.configurationId === configurationId)
					.map((profile) => profile.name)
			: []

	const openProfile = async (id: string) => {
		setError(undefined)
		try {
			const response = await ModelsServiceClient.listApiProfiles(EmptyRequest.create({}))
			const stored = response.profiles.find((p) => p.id === id)
			if (stored) {
				setDraft(draftFromProto(stored))
			}
		} catch (err) {
			console.error("Failed to load API configuration:", err)
		}
	}

	const save = async (next: ProfileDraft) => {
		setIsSaving(true)
		setError(undefined)
		try {
			// The backend refreshes saved connection/model edits and preserves chat effort.
			await ModelsServiceClient.saveApiProfile(buildSaveRequest(next))
			setDraft(undefined)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save configuration.")
		} finally {
			setIsSaving(false)
		}
	}

	const remove = async () => {
		if (!draft?.id || profilesUsing(draft.id).length > 0) {
			return
		}
		try {
			await ModelsServiceClient.deleteApiProfile(DeleteApiProfileRequest.create({ id: draft.id }))
			setDraft(undefined)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete configuration.")
		}
	}

	if (draft) {
		return (
			<ApiProfileEditor
				draft={draft}
				error={error}
				isSaving={isSaving}
				onBack={() => {
					setError(undefined)
					setDraft(undefined)
				}}
				onChange={setDraft}
				onDelete={remove}
				onDuplicate={() => setDraft(duplicateDraft(draft))}
				onSave={save}
				usedBy={profilesUsing(draft.id)}
			/>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<div className="flex items-center mb-2">
					<span className="font-medium flex-1">API Configurations</span>
					<VSCodeButton
						onClick={() => {
							setError(undefined)
							setDraft(newProfileDraft())
						}}>
						+ New
					</VSCodeButton>
				</div>
				<div className="flex flex-col gap-2">
					{profiles.length === 0 && (
						<p className="text-xs text-(--vscode-descriptionForeground)">
							No configurations yet. Create one, then use it in a profile.
						</p>
					)}
					{profiles.map((profile) => (
						<button
							className="text-left w-full rounded-sm p-2 cursor-pointer border border-solid border-(--vscode-panel-border) bg-(--vscode-editor-background) text-(--vscode-foreground) hover:bg-(--vscode-list-hoverBackground)"
							key={profile.id}
							onClick={() => openProfile(profile.id)}
							type="button">
							<div className="flex items-center gap-2">
								<b>{profile.name}</b>
								<span className="flex-1" />
								<span className="codicon codicon-chevron-right text-(--vscode-descriptionForeground)" />
							</div>
							<div className="text-xs mt-0.5 text-(--vscode-descriptionForeground)">
								{describeProfile({
									provider: profile.provider,
									modelId: profile.modelId,
									openAiCompatibleApiType: profile.openAiCompatibleApiType as
										| OpenAiCompatibleApiType
										| undefined,
								})}
							</div>
						</button>
					))}
				</div>
			</div>
		</div>
	)
}

export default ApiProfilesPanel
