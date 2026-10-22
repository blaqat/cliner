import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { memo, type ReactNode, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { WorktreeSettings } from "@/components/worktrees/WorktreeSettings"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { DEFAULT_TOAST_SECONDS } from "../../toasts/threadToastRules"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"
import { FeatureField, FeatureGroup, FeatureRow } from "./FeatureRow"

// Interface for feature toggle configuration
interface FeatureToggle {
	id: string
	label: string
	description: ReactNode
	settingKey: keyof UpdateSettingsRequest
	stateKey: string
}

const agentFeatures: FeatureToggle[] = [
	{
		id: "auto-compact",
		label: "Auto Compact",
		description: "Automatically compress conversation history.",
		stateKey: "useAutoCondense",
		settingKey: "useAutoCondense",
	},
]

const editorFeatures: FeatureToggle[] = [
	{
		id: "show-feature-tips",
		label: "Feature Tips",
		description: "Show rotating tips during the thinking phase to help you discover Cline features.",
		stateKey: "showFeatureTips",
		settingKey: "showFeatureTips",
	},
	{
		id: "background-edit",
		label: "Background Edit",
		description: "Allow edits without stealing editor focus",
		stateKey: "backgroundEditEnabled",
		settingKey: "backgroundEditEnabled",
	},
	{
		id: "checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback",
		stateKey: "enableCheckpointsSetting",
		settingKey: "enableCheckpointsSetting",
	},
]

const advancedFeatures: FeatureToggle[] = [
	{
		id: "hooks",
		label: "Hooks",
		description: "Enable lifecycle and tool hooks during task execution.",
		stateKey: "hooksEnabled",
		settingKey: "hooksEnabled",
	},
]

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const {
		enableCheckpointsSetting,
		hooksEnabled,
		mcpDisplayMode,
		useAutoCondense,
		compactionStrategy,
		webSearchEnabled,
		subagentsEnabled,
		worktreesEnabled,
		backgroundEditEnabled,
		showFeatureTips,
		threadToastsEnabled,
		threadToastSeconds,
		continueAnswerOnActSwitch,
	} = useExtensionState()
	// The duration field commits on blur, like other number settings.
	const [toastSecondsDraft, setToastSecondsDraft] = useState<string>()
	const toastsOn = threadToastsEnabled !== false
	const storedToastSeconds = String(threadToastSeconds ?? DEFAULT_TOAST_SECONDS)

	// State lookup for mapped features
	const featureState: Record<string, boolean | undefined> = {
		showFeatureTips,
		enableCheckpointsSetting,
		hooksEnabled,
		useAutoCondense,
		subagentsEnabled,
		worktreesEnabled: worktreesEnabled?.user,
		backgroundEditEnabled,
	}

	// Visibility lookup for features with feature flags
	const featureVisibility: Record<string, boolean | undefined> = {
		worktreesEnabled: worktreesEnabled?.featureFlag,
	}

	return (
		<div className="mb-2">
			{renderSectionHeader("features")}
			<Section>
				<div className="mb-5 flex flex-col gap-3">
					{/* Core features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Agent</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="agent-features">
							{agentFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									id={feature.id}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
							<div className="space-y-2 py-3">
								<Label className="text-sm font-medium text-foreground">Auto Compact Strategy</Label>
								<p className="text-xs text-muted-foreground">Controls how auto compaction rewrites context.</p>
								<Select
									disabled={!useAutoCondense}
									onValueChange={(value) => updateSetting("compactionStrategy", value)}
									value={compactionStrategy ?? "agentic"}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="basic">Basic</SelectItem>
										<SelectItem value="agentic">Agentic</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<FeatureRow
								checked={webSearchEnabled}
								description="Let the model search the web when the selected provider and model support it. Applies to new tasks."
								label="Web Search"
								onChange={(checked) => updateSetting("webSearchEnabled", checked)}
							/>
							<FeatureRow
								checked={continueAnswerOnActSwitch !== false}
								description="Right after an Ask answer, switching to Act also tells Cline to carry it out (with anything you typed). Off: switching only changes the mode; the answer's Continue in Act button still carries it out."
								id="continue-answer-on-act-switch"
								label="Continue the answer when switching to Act"
								onChange={(checked) => updateSetting("continueAnswerOnActSwitch", checked)}
							/>
						</div>
					</div>

					<WorktreeSettings />
					{/* Editor features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Editor</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="optional-features">
							{editorFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									id={feature.id}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
						</div>
					</div>
				</div>

				{/* Notifications */}
				<FeatureGroup id="notification-features" title="Notifications">
					<FeatureRow
						checked={toastsOn}
						description="When a thread you're not viewing finishes or needs input (an approval or a question). Needs-input toasts stay until handled."
						id="thread-toasts"
						label="In-app Toasts"
						onChange={(checked) => updateSetting("threadToastsEnabled", checked)}
					/>
					<FeatureField
						className="pt-0"
						description="Hovering pauses it. While VS Code is in the background, the timer waits until you come back."
						htmlFor="thread-toast-seconds"
						label="Completion toast duration (seconds)">
						<Input
							data-testid="thread-toast-seconds"
							disabled={!toastsOn}
							id="thread-toast-seconds"
							min={1}
							onBlur={() => {
								const seconds = Number((toastSecondsDraft ?? storedToastSeconds).trim())
								if (Number.isInteger(seconds) && seconds >= 1 && seconds !== threadToastSeconds) {
									updateSetting("threadToastSeconds", seconds)
								}
								setToastSecondsDraft(undefined)
							}}
							onChange={(event) => setToastSecondsDraft(event.target.value)}
							step={1}
							type="number"
							value={toastSecondsDraft ?? storedToastSeconds}
						/>
					</FeatureField>
				</FeatureGroup>

				{/* Advanced */}
				<div>
					<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Advanced</div>
					<div className="relative p-3 my-3 rounded-md border border-editor-widget-border/50" id="advanced-features">
						<div className="space-y-3">
							{advancedFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									id={feature.id}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}

							{/* MCP Display Mode */}
							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">MCP Display Mode</Label>
								<p className="text-xs text-muted-foreground">Controls how MCP responses are displayed</p>
								<Select onValueChange={(v) => updateSetting("mcpDisplayMode", v)} value={mcpDisplayMode}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="plain">Plain Text</SelectItem>
										<SelectItem value="rich">Rich Display</SelectItem>
										<SelectItem value="markdown">Markdown</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
					</div>
				</div>
			</Section>
		</div>
	)
}
export default memo(FeatureSettingsSection)
