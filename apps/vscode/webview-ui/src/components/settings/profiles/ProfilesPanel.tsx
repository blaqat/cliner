import type { ModelProfile } from "@shared/model-profiles"
import { ModelProfile as ProtoModelProfile, UpdateSettingsRequest } from "@shared/proto/cline/state"
import { OPENAI_REASONING_EFFORT_OPTIONS, type OpenaiReasoningEffort } from "@shared/storage/types"
import { VSCodeButton, VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { formatReasoningEffort, Hint, Label } from "../apiProfiles/ApiProfileEditor"
import { updateSetting } from "../utils/settingsHandlers"

/** Reserved id in subagentAllowedProfileIds: the agent may inherit the thread's model. */
const INHERIT_PROFILE_ID = "parent"

const CARD_CLASS =
	"w-full rounded-sm p-2 border border-solid border-(--vscode-panel-border) bg-(--vscode-editor-background) text-(--vscode-foreground)"

interface ProfileDraft {
	/** Undefined for a profile not created yet. */
	id?: string
	name: string
	configurationId: string
	reasoningEffort: OpenaiReasoningEffort
}

const updateSettings = (request: Partial<UpdateSettingsRequest>) =>
	StateServiceClient.updateSettings(UpdateSettingsRequest.create(request))

interface ProfilePickerProps {
	label: string
	ariaLabel: string
	value: string
	profiles: ModelProfile[]
	onPick: (profileId: string) => void
	/** Extra option shown first (e.g. "Same as thread") stored as the empty string. */
	inheritLabel?: string
}

const ProfilePicker = ({ label, ariaLabel, value, profiles, onPick, inheritLabel }: ProfilePickerProps) => (
	<div className="flex items-center gap-2">
		<span className="w-36 text-sm shrink-0">{label}</span>
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

interface ProfileEditorProps {
	draft: ProfileDraft
	configurations: { id: string; name: string }[]
	isSaving: boolean
	error?: string
	/** Why the profile cannot be deleted, if it cannot. */
	deleteBlockedReason?: string
	onChange: (draft: ProfileDraft) => void
	onSave: () => void
	onCancel: () => void
	onDelete?: () => void
}

/** Inline editor shown in place of a profile's card (or atop the list for a new one). */
const ProfileEditor = ({
	draft,
	configurations,
	isSaving,
	error,
	deleteBlockedReason,
	onChange,
	onSave,
	onCancel,
	onDelete,
}: ProfileEditorProps) => {
	const isNew = !draft.id
	const idPrefix = `profile-${draft.id ?? "new"}`
	return (
		<div className={`${CARD_CLASS} flex flex-col gap-3`} data-testid="profile-editor">
			<VSCodeTextField
				data-testid="profile-editor-name"
				onInput={(e) => onChange({ ...draft, name: (e.target as HTMLInputElement).value })}
				placeholder={configurations.find((c) => c.id === draft.configurationId)?.name ?? "e.g. Deep review"}
				style={{ width: "100%" }}
				value={draft.name}>
				<span className="font-medium">Name</span>
			</VSCodeTextField>

			<div>
				<Label htmlFor={`${idPrefix}-model`}>Model</Label>
				<VSCodeDropdown
					aria-label="Profile model"
					className="w-full"
					id={`${idPrefix}-model`}
					onChange={(e) => onChange({ ...draft, configurationId: (e.target as HTMLSelectElement).value })}
					value={draft.configurationId}>
					{configurations.map((configuration) => (
						<VSCodeOption key={configuration.id} value={configuration.id}>
							{configuration.name}
						</VSCodeOption>
					))}
				</VSCodeDropdown>
				<Hint>A configuration from the Models tab.</Hint>
			</div>

			<div>
				<Label htmlFor={`${idPrefix}-effort`}>Reasoning effort</Label>
				<VSCodeDropdown
					aria-label="Profile reasoning effort"
					className="w-full"
					id={`${idPrefix}-effort`}
					onChange={(e) =>
						onChange({ ...draft, reasoningEffort: (e.target as HTMLSelectElement).value as OpenaiReasoningEffort })
					}
					value={draft.reasoningEffort}>
					{OPENAI_REASONING_EFFORT_OPTIONS.map((effort) => (
						<VSCodeOption key={effort} value={effort}>
							{formatReasoningEffort(effort)}
						</VSCodeOption>
					))}
				</VSCodeDropdown>
			</div>

			{error && <p className="text-xs text-(--vscode-errorForeground)">{error}</p>}

			<div className="flex items-center gap-2">
				<VSCodeButton disabled={isSaving || !draft.configurationId} onClick={onSave}>
					{isNew ? "Create" : "Save"}
				</VSCodeButton>
				<VSCodeButton appearance="secondary" onClick={onCancel}>
					Cancel
				</VSCodeButton>
				<span className="flex-1" />
				{!isNew && onDelete && (
					<VSCodeButton appearance="secondary" disabled={!!deleteBlockedReason || isSaving} onClick={onDelete}>
						Delete
					</VSCodeButton>
				)}
			</div>
			{!isNew && deleteBlockedReason && <Hint>{deleteBlockedReason}</Hint>}
		</div>
	)
}

const toProto = (profile: ProfileDraft | ModelProfile) =>
	ProtoModelProfile.create({
		id: profile.id ?? "",
		name: profile.name.trim(),
		configurationId: profile.configurationId,
		reasoningEffort: profile.reasoningEffort ?? "none",
	})

/** Thread: what new threads start on, one profile or one per mode. */
const ThreadSection = ({ profiles }: { profiles: ModelProfile[] }) => {
	const { threadDefaultProfileId, threadSeparateAskActProfiles, threadAskProfileId, threadActProfileId } = useExtensionState()
	const separate = threadSeparateAskActProfiles === true
	const defaultId = threadDefaultProfileId ?? ""

	const setSeparate = (checked: boolean) => {
		// Turning it on starts both modes on the current default; turning it off keeps Act's.
		const request: Partial<UpdateSettingsRequest> = checked
			? {
					threadSeparateAskActProfiles: true,
					threadAskProfileId: threadAskProfileId ?? defaultId,
					threadActProfileId: threadActProfileId ?? defaultId,
				}
			: { threadSeparateAskActProfiles: false, threadDefaultProfileId: threadActProfileId ?? defaultId }
		updateSettings(request).catch((err) => console.error("Failed to update thread defaults:", err))
	}

	return (
		<div>
			<div className="font-medium mb-2">Thread</div>
			<div className="flex items-center gap-2 mb-2">
				<Switch checked={separate} id="thread-separate-profiles" onCheckedChange={setSeparate} />
				<label className="text-sm" htmlFor="thread-separate-profiles">
					Different profile for Ask and Act
				</label>
			</div>
			{separate ? (
				<div className="flex flex-col gap-2">
					<ProfilePicker
						ariaLabel="Ask default profile"
						label="Ask"
						onPick={(id) => id && updateSetting("threadAskProfileId", id)}
						profiles={profiles}
						value={threadAskProfileId ?? defaultId}
					/>
					<ProfilePicker
						ariaLabel="Act default profile"
						label="Act"
						onPick={(id) => id && updateSetting("threadActProfileId", id)}
						profiles={profiles}
						value={threadActProfileId ?? defaultId}
					/>
				</div>
			) : (
				<ProfilePicker
					ariaLabel="Thread default profile"
					label="Default"
					onPick={(id) => id && updateSetting("threadDefaultProfileId", id)}
					profiles={profiles}
					value={defaultId}
				/>
			)}
			<Hint>New threads start on this model and effort. Change them per chat in the composer.</Hint>
		</div>
	)
}

/** Subagents: whether spawned agents may run on profiles, and which. */
const SubagentsSection = ({ profiles }: { profiles: ModelProfile[] }) => {
	const state = useExtensionState()
	const enabled = state.subagentProfilesEnabled ?? false
	const allowedIds = state.subagentAllowedProfileIds ?? []

	const toggleAllowed = (id: string) => {
		const next = allowedIds.includes(id) ? allowedIds.filter((allowed) => allowed !== id) : [...allowedIds, id]
		updateSetting("subagentAllowedProfileIds", { values: next })
	}

	return (
		<div>
			<div className="font-medium mb-2">Subagents</div>
			<div className="flex items-center gap-2">
				<Switch
					checked={enabled}
					id="subagent-profiles-enabled"
					onCheckedChange={(value) => updateSetting("subagentProfilesEnabled", value)}
				/>
				<label className="text-sm" htmlFor="subagent-profiles-enabled">
					Let subagents use profiles
				</label>
			</div>
			{enabled && (
				<div className="mt-2 flex flex-col gap-2">
					<ProfilePicker
						ariaLabel="Subagent default profile"
						inheritLabel="Same as thread"
						label="Default"
						onPick={(id) => updateSetting("subagentDefaultProfileId", id)}
						profiles={profiles}
						value={state.subagentDefaultProfileId ?? ""}
					/>
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
						</div>
					</div>
				</div>
			)}
			<Hint>Subagent permissions and concurrency live in the Subagents tab.</Hint>
		</div>
	)
}

/** Text generation: one-off model calls that run on a profile. */
const TextGenerationSection = ({ profiles }: { profiles: ModelProfile[] }) => {
	const state = useExtensionState()
	const titlesEnabled = state.threadTitlesEnabled ?? false
	return (
		<div>
			<div className="font-medium mb-2">Text generation</div>
			<div className="flex flex-col gap-4">
				<div>
					<ProfilePicker
						ariaLabel="Walkthrough Generate profile"
						label="Walkthrough Generate"
						onPick={(id) => id && updateSetting("walkthroughGenerateProfileId", id)}
						profiles={profiles}
						value={state.walkthroughGenerateProfileId ?? ""}
					/>
					<Hint>Remembers the last profile used to write a walkthrough.</Hint>
				</div>
				<div>
					<div className="flex items-center gap-2">
						<Switch
							checked={titlesEnabled}
							id="thread-titles-enabled"
							onCheckedChange={(value) => updateSetting("threadTitlesEnabled", value)}
						/>
						<label className="text-sm" htmlFor="thread-titles-enabled">
							Name new threads automatically
						</label>
					</div>
					<Hint>Generates a short title after the first message, once per thread. Costs a model call.</Hint>
					{titlesEnabled && (
						<div className="mt-2">
							<ProfilePicker
								ariaLabel="Thread title profile"
								inheritLabel="Same as thread"
								label="Thread titles"
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

const ProfilesPanel = () => {
	const state = useExtensionState()
	const profiles = state.profiles ?? []
	const configurations = state.apiConfigProfiles ?? []
	const [draft, setDraft] = useState<ProfileDraft | undefined>(undefined)
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)

	const configurationName = (id: string) => configurations.find((c) => c.id === id)?.name ?? "Missing model"

	/** Profiles new threads start on cannot be deleted; pick another default first. */
	const threadDefaultIds = new Set(
		(state.threadSeparateAskActProfiles
			? [state.threadAskProfileId ?? state.threadDefaultProfileId, state.threadActProfileId ?? state.threadDefaultProfileId]
			: [state.threadDefaultProfileId]
		).filter((id): id is string => !!id),
	)

	const persist = async (next: (ProfileDraft | ModelProfile)[]) => {
		setIsSaving(true)
		setError(undefined)
		try {
			await updateSettings({ profiles: { values: next.map(toProto) } })
			setDraft(undefined)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save profiles.")
		} finally {
			setIsSaving(false)
		}
	}

	const save = () => {
		if (!draft) return
		const next = draft.id ? profiles.map((profile) => (profile.id === draft.id ? draft : profile)) : [...profiles, draft]
		void persist(next)
	}

	const remove = () => {
		if (!draft?.id || threadDefaultIds.has(draft.id)) return
		void persist(profiles.filter((profile) => profile.id !== draft.id))
	}

	const edit = (next: ProfileDraft | undefined) => {
		setError(undefined)
		setDraft(next)
	}

	const editor = (current: ProfileDraft) => (
		<ProfileEditor
			configurations={configurations}
			deleteBlockedReason={
				current.id && threadDefaultIds.has(current.id)
					? "New threads start on this profile. Choose another Thread default to delete it."
					: undefined
			}
			draft={current}
			error={error}
			isSaving={isSaving}
			onCancel={() => edit(undefined)}
			onChange={setDraft}
			onDelete={remove}
			onSave={save}
		/>
	)

	return (
		<div className="flex flex-col gap-4">
			<div>
				<div className="flex items-center mb-2">
					<span className="font-medium flex-1">Profiles</span>
					<VSCodeButton
						disabled={configurations.length === 0}
						onClick={() =>
							edit({
								name: "",
								configurationId: configurations[0]?.id ?? "",
								reasoningEffort: configurations[0]?.reasoningEffort ?? "none",
							})
						}>
						+ New
					</VSCodeButton>
				</div>
				<div className="flex flex-col gap-2">
					{draft && !draft.id && editor(draft)}
					{profiles.length === 0 && !draft && (
						<p className="text-xs text-(--vscode-descriptionForeground)">
							No profiles yet. A profile runs a model from the Models tab at a reasoning effort.
						</p>
					)}
					{profiles.map((profile) =>
						draft?.id === profile.id ? (
							<div key={profile.id}>{editor(draft)}</div>
						) : (
							<button
								className={`${CARD_CLASS} text-left cursor-pointer hover:bg-(--vscode-list-hoverBackground)`}
								key={profile.id}
								onClick={() => edit({ ...profile, reasoningEffort: profile.reasoningEffort ?? "none" })}
								type="button">
								<div className="flex items-center gap-2">
									<b>{profile.name}</b>
									<span className="flex-1" />
									<span className="codicon codicon-chevron-right text-(--vscode-descriptionForeground)" />
								</div>
								<div className="text-xs mt-0.5 text-(--vscode-descriptionForeground)">
									{configurationName(profile.configurationId)} ·{" "}
									{formatReasoningEffort(profile.reasoningEffort ?? "none")}
								</div>
							</button>
						),
					)}
				</div>
			</div>

			<ThreadSection profiles={profiles} />
			<SubagentsSection profiles={profiles} />
			<TextGenerationSection profiles={profiles} />
		</div>
	)
}

export default ProfilesPanel
