import type { OpenAiCompatibleApiType } from "@shared/api-profiles"
import { EmptyRequest } from "@shared/proto/cline/common"
import { AssignApiProfileRequest, DeleteApiProfileRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { OPENAI_REASONING_EFFORT_OPTIONS } from "@shared/storage/types"
import { VSCodeButton, VSCodeCheckbox, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { updateSetting } from "../utils/settingsHandlers"
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

/** Reserved id in subagentAllowedProfileIds: the agent may inherit the thread's model. */
const INHERIT_PROFILE_ID = "parent"

const effortLabel = (effort: string) =>
	effort === "none" ? "None / provider default" : effort.charAt(0).toUpperCase() + effort.slice(1)

interface ProfilePickerProps {
	label: string
	ariaLabel: string
	value: string
	profiles: { id: string; name: string }[]
	onPick: (profileId: string) => void
	/** Extra option shown first (e.g. "Same as thread") stored as the empty string. */
	inheritLabel?: string
	widthClass?: string
}

const ProfilePicker = ({ label, ariaLabel, value, profiles, onPick, inheritLabel, widthClass = "w-28" }: ProfilePickerProps) => (
	<div className="flex items-center gap-2">
		<span className={`${widthClass} text-sm shrink-0`}>{label}</span>
		<VSCodeDropdown
			aria-label={ariaLabel}
			className="flex-1"
			key={`${value}:${profiles.map((p) => p.id).join(",")}`}
			onChange={(e) => onPick((e.target as HTMLSelectElement).value)}
			value={value}>
			{inheritLabel !== undefined && <VSCodeOption value="">{inheritLabel}</VSCodeOption>}
			{profiles.map((profile) => (
				<VSCodeOption key={profile.id} value={profile.id}>
					{profile.name}
				</VSCodeOption>
			))}
			{!value && inheritLabel === undefined && <VSCodeOption value="">Choose…</VSCodeOption>}
		</VSCodeDropdown>
	</div>
)

interface UsedByProps {
	profiles: { id: string; name: string }[]
}

/** "Used by": which saved configuration each feature runs on. Always open. */
const UsedBySection = ({ profiles }: UsedByProps) => {
	const state = useExtensionState()
	const subagentProfilesEnabled = state.subagentProfilesEnabled ?? false
	const allowedIds = state.subagentAllowedProfileIds ?? []
	const threadTitlesEnabled = state.threadTitlesEnabled ?? false

	const toggleAllowed = (id: string) => {
		const next = allowedIds.includes(id) ? allowedIds.filter((allowed) => allowed !== id) : [...allowedIds, id]
		updateSetting("subagentAllowedProfileIds", { values: next })
	}

	return (
		<div>
			<div className="font-medium mb-2">Used by</div>
			<div className="flex flex-col gap-4">
				<div>
					<div className="flex items-center gap-2">
						<Switch
							checked={subagentProfilesEnabled}
							id="subagent-profiles-enabled"
							onCheckedChange={(value) => updateSetting("subagentProfilesEnabled", value)}
						/>
						<label className="text-sm" htmlFor="subagent-profiles-enabled">
							Choose a profile for subagents
						</label>
					</div>
					{subagentProfilesEnabled && (
						<div className="mt-2 flex flex-col gap-2">
							<ProfilePicker
								ariaLabel="Subagent default profile"
								inheritLabel="Same as thread"
								label="Default"
								onPick={(id) => updateSetting("subagentDefaultProfileId", id)}
								profiles={profiles}
								value={state.subagentDefaultProfileId ?? ""}
							/>
							<div className="flex items-center gap-2">
								<span className="w-28 text-sm shrink-0">Reasoning</span>
								<VSCodeDropdown
									aria-label="Subagent default reasoning"
									className="flex-1"
									onChange={(e) =>
										updateSetting("subagentReasoningEffort", (e.target as HTMLSelectElement).value)
									}
									value={state.subagentReasoningEffort ?? "none"}>
									{OPENAI_REASONING_EFFORT_OPTIONS.map((effort) => (
										<VSCodeOption key={effort} value={effort}>
											{effortLabel(effort)}
										</VSCodeOption>
									))}
								</VSCodeDropdown>
							</div>
							<div>
								<div className="text-sm mb-1">Agent may choose</div>
								<div className="flex flex-col gap-1">
									<VSCodeCheckbox
										checked={allowedIds.includes(INHERIT_PROFILE_ID)}
										onChange={() => toggleAllowed(INHERIT_PROFILE_ID)}>
										Same as parent
									</VSCodeCheckbox>
									{profiles.map((profile) => (
										<VSCodeCheckbox
											checked={allowedIds.includes(profile.id)}
											key={profile.id}
											onChange={() => toggleAllowed(profile.id)}>
											{profile.name}
										</VSCodeCheckbox>
									))}
									{profiles.length === 0 && (
										<p className="text-xs text-(--vscode-descriptionForeground)">
											Create a profile above to let subagents run on it.
										</p>
									)}
								</div>
							</div>
							<p className="text-xs text-(--vscode-descriptionForeground)">
								Subagent permissions and concurrency live in the Subagents tab.
							</p>
						</div>
					)}
				</div>

				<div>
					<ProfilePicker
						ariaLabel="Walkthrough Generate profile"
						inheritLabel="Same as thread"
						label="Walkthrough Generate"
						onPick={(id) => updateSetting("walkthroughGenerateProfileId", id)}
						profiles={profiles}
						value={state.walkthroughGenerateProfileId ?? ""}
						widthClass="w-36"
					/>
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						Remembers the last profile used to write a walkthrough.
					</p>
				</div>

				<div>
					<div className="flex items-center gap-2">
						<Switch
							checked={threadTitlesEnabled}
							id="thread-titles-enabled"
							onCheckedChange={(value) => updateSetting("threadTitlesEnabled", value)}
						/>
						<label className="text-sm" htmlFor="thread-titles-enabled">
							Name new threads automatically
						</label>
					</div>
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						Generates a short title after the first message, once per thread. Costs a model call.
					</p>
					{threadTitlesEnabled && (
						<div className="mt-2">
							<ProfilePicker
								ariaLabel="Thread title profile"
								inheritLabel="Same as thread"
								label="Profile"
								onPick={(id) => updateSetting("threadTitlesProfileId", id)}
								profiles={profiles}
								value={state.threadTitlesProfileId ?? ""}
							/>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

const ApiProfilesPanel = () => {
	const { apiConfigProfiles, askProfileId, actProfileId, planActSeparateModelsSetting } = useExtensionState()
	const [draft, setDraft] = useState<ProfileDraft | undefined>(undefined)
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)

	const profiles = apiConfigProfiles ?? []
	const separate = planActSeparateModelsSetting === true
	const assignedId: Record<ProfileMode, string | undefined> = { plan: askProfileId, act: actProfileId }
	const modesUsing = (profileId: string | undefined) =>
		profileId ? MODES.filter((m) => assignedId[m.mode] === profileId).map((m) => m.label) : []

	const assign = async (mode: ProfileMode, profileId: string) => {
		if (!profileId) return
		try {
			// Per-mode keys only take effect when Ask and Act may differ.
			if (!separate) {
				await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ planActSeparateModelsSetting: true }))
			}
			await ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode, profileId }))
		} catch (err) {
			console.error("Failed to assign API configuration:", err)
		}
	}

	/** One Default for both modes: same profile id on ask/act, flag off. */
	const assignBoth = async (profileId: string) => {
		if (!profileId) return
		try {
			await ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode: "plan", profileId }))
			await ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode: "act", profileId }))
			if (separate) {
				await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ planActSeparateModelsSetting: false }))
			}
		} catch (err) {
			console.error("Failed to assign API configuration:", err)
		}
	}

	const setSeparate = async (checked: boolean) => {
		try {
			if (checked) {
				await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ planActSeparateModelsSetting: true }))
				return
			}
			// Converging on one profile: the Act assignment survives and applies to both.
			const keep = actProfileId ?? askProfileId ?? profiles[0]?.id
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ planActSeparateModelsSetting: false }))
			if (keep) {
				await ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode: "plan", profileId: keep }))
				await ModelsServiceClient.assignApiProfile(AssignApiProfileRequest.create({ mode: "act", profileId: keep }))
			}
		} catch (err) {
			console.error("Failed to update Ask/Act defaults:", err)
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
				<div className="flex items-center mb-2">
					<span className="font-medium flex-1">Profiles</span>
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
							No profiles yet. Create one to choose what Ask and Act use.
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

			<div>
				<div className="font-medium mb-2">Ask / Act defaults</div>
				<div className="flex items-center gap-2 mb-2">
					<Switch checked={separate} id="different-profiles-switch" onCheckedChange={(value) => setSeparate(value)} />
					<label className="text-sm" htmlFor="different-profiles-switch">
						Different profile for Ask and Act
					</label>
				</div>
				{separate ? (
					<div className="flex flex-col gap-2">
						{MODES.map(({ mode, label }) => (
							<ProfilePicker
								ariaLabel={`${label} configuration`}
								key={mode}
								label={`${label} uses`}
								onPick={(id) => assign(mode, id)}
								profiles={profiles}
								value={assignedId[mode] ?? ""}
								widthClass="w-14"
							/>
						))}
					</div>
				) : (
					<div>
						<ProfilePicker
							ariaLabel="Default configuration"
							label="Default"
							onPick={(id) => assignBoth(id)}
							profiles={profiles}
							value={actProfileId ?? askProfileId ?? ""}
							widthClass="w-14"
						/>
						<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">Ask and Act use the same profile.</p>
					</div>
				)}
			</div>

			<UsedBySection profiles={profiles} />
		</div>
	)
}

export default ApiProfilesPanel
