import type { OpenAiCompatibleApiType } from "@shared/api-profiles"
import { EmptyRequest } from "@shared/proto/cline/common"
import { AssignApiProfileRequest, DeleteApiProfileRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import ApiProfileEditor from "./ApiProfileEditor"
import {
	buildSaveRequest,
	describeProfile,
	draftFromProto,
	duplicateDraft,
	newProfileDraft,
	type ProfileDraft,
} from "./profileDraft"

const MODES = [
	{ mode: "plan", label: "Ask" },
	{ mode: "act", label: "Act" },
] as const

type ProfileMode = (typeof MODES)[number]["mode"]

const ModeBadge = ({ label }: { label: string }) => (
	<span className="text-[10px] px-1.5 py-px rounded-full border border-solid border-(--vscode-badge-background) bg-(--vscode-badge-background) text-(--vscode-badge-foreground)">
		{label}
	</span>
)

const ApiProfilesPanel = () => {
	const { apiConfigProfiles, askProfileId, actProfileId, planActSeparateModelsSetting } = useExtensionState()
	const [draft, setDraft] = useState<ProfileDraft | undefined>(undefined)
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)

	const profiles = apiConfigProfiles ?? []
	const assignedId: Record<ProfileMode, string | undefined> = { plan: askProfileId, act: actProfileId }
	const modesUsing = (profileId: string | undefined) =>
		profileId ? MODES.filter((m) => assignedId[m.mode] === profileId).map((m) => m.label) : []

	const assign = async (mode: ProfileMode, profileId: string) => {
		try {
			// Per-mode keys only take effect when Ask and Act may differ.
			if (!planActSeparateModelsSetting) {
				await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ planActSeparateModelsSetting: true }))
			}
			await ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode, profileId }))
		} catch (err) {
			console.error("Failed to assign API configuration:", err)
		}
	}

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
			const response = await ModelsServiceClient.saveApiProfile(buildSaveRequest(next))
			const savedId = response.profile?.id ?? next.id
			// Re-assign so edits to a configuration in use take effect for its modes.
			for (const { mode } of MODES) {
				if (savedId && assignedId[mode] === savedId) {
					await ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode, profileId: savedId }))
				}
			}
			setDraft(undefined)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save configuration.")
		} finally {
			setIsSaving(false)
		}
	}

	const remove = async () => {
		if (!draft?.id || modesUsing(draft.id).length > 0) {
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
				assignedModes={modesUsing(draft.id)}
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
			/>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<div className="font-medium mb-2">Modes</div>
				<div className="flex flex-col gap-2">
					{MODES.map(({ mode, label }) => {
						const selected = assignedId[mode] ?? ""
						return (
							<div className="flex items-center gap-2" key={mode}>
								<span className="w-14 text-sm">{label} uses</span>
								<VSCodeDropdown
									aria-label={`${label} configuration`}
									className="flex-1"
									key={`${mode}:${selected}:${profiles.map((p) => p.id).join(",")}`}
									onChange={(e) => assign(mode, (e.target as HTMLSelectElement).value)}
									value={selected}>
									{profiles.map((profile) => (
										<VSCodeOption key={profile.id} value={profile.id}>
											{profile.name}
										</VSCodeOption>
									))}
								</VSCodeDropdown>
							</div>
						)
					})}
				</div>
			</div>

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
							No configurations yet. Create one to choose what Ask and Act use.
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
								{modesUsing(profile.id).map((label) => (
									<ModeBadge key={label} label={label} />
								))}
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
