import { languageOptions } from "@shared/Languages"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { WorktreeSettings } from "@/components/worktrees/WorktreeSettings"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ResetStateRequest } from "@shared/proto/cline/state"
import { StateServiceClient } from "@/services/grpc-client"
import TerminalEnvironmentEditor from "../environment/TerminalEnvironmentEditor"
import AboutSection from "../sections/AboutSection"
import ApiConfigurationSection from "../sections/ApiConfigurationSection"
import DebugSection from "../sections/DebugSection"
import ProfilesSection from "../sections/ProfilesSection"
import { RemoteConfigSection } from "../sections/RemoteConfigSection"
import { AdvancedFold } from "./AdvancedFold"
import { NumberRow, SelectRow, SettingBlock, SettingRow, ToggleRow } from "./SettingRow"
import { useSettingsShell } from "./SettingsShellContext"
import { findRow, isRowVisible } from "./settingsRegistry"

/**
 * What each page holds until Phases 6 and 7 replace it, so every control stays reachable.
 * Sections that map to one page are mounted whole. Features, General, Terminal and Subagents spread
 * across pages or stores, so their controls appear here as registry rows; those old sections stay
 * as they are for the rollout-off Settings.
 */

const noHeader = () => null

const positiveInteger = (text: string) => {
	const value = Number(text.trim())
	return text.trim() !== "" && Number.isInteger(value) && value >= 1 ? value : undefined
}

export const TemporaryModelsPage = () => {
	const { settingsInitialModelTab } = useExtensionState()
	return (
		<>
			<SettingBlock rowId="models.connections">
				<ApiConfigurationSection initialModelTab={settingsInitialModelTab} renderSectionHeader={noHeader} />
			</SettingBlock>
			<SettingRow rowId="models.background">
				<AdvancedFold featureId="models.background" summary="titles, commit messages, Generate">
					<SettingBlock rowId="models.background.generate">
						<ProfilesSection renderSectionHeader={noHeader} />
					</SettingBlock>
				</AdvancedFold>
			</SettingRow>
		</>
	)
}

export const TemporaryAgentPage = () => (
	<>
		<SelectRow options={languageOptions.map(({ display }) => ({ value: display, label: display }))} rowId="agent.language" />
		<ToggleRow rowId="agent.checkpoints" />
		<ToggleRow rowId="agent.background-edit" />
		<ToggleRow rowId="agent.compact">
			<AdvancedFold featureId="agent.compact" summary="strategy">
				<SelectRow
					options={[
						{ value: "basic", label: "Basic" },
						{ value: "agentic", label: "Agentic" },
					]}
					rowId="agent.compact.strategy"
				/>
			</AdvancedFold>
		</ToggleRow>
		<ToggleRow rowId="agent.continue-on-act" />
	</>
)

export const TemporarySubagentsPage = () => {
	const parse = (text: string) => {
		const value = text.trim() === "" ? 0 : Number(text)
		return Number.isInteger(value) && value >= 0 ? value : undefined
	}
	return (
		<>
			<ToggleRow rowId="subagents.enabled" />
			<NumberRow
				invalid="A whole number"
				parse={parse}
				placeholder="Unlimited"
				rowId="subagents.cap"
				toText={(value) => (value === 0 ? "" : String(value))}
			/>
			<ToggleRow rowId="subagents.access.write" />
			<ToggleRow rowId="subagents.access.commands" />
			<ToggleRow rowId="subagents.access.web" />
			<ToggleRow rowId="subagents.access.mcp" />
		</>
	)
}

export const TemporaryToolsPage = () => {
	const { availableTerminalProfiles, navigateToMcp } = useExtensionState()
	const parseSeconds = (text: string) => {
		const seconds = Number.parseFloat(text)
		return Number.isNaN(seconds) || seconds <= 0 ? undefined : Math.round(seconds * 1000)
	}
	return (
		<>
			<SettingRow
				control={({ id }) => (
					<Button id={id} onClick={() => navigateToMcp()} size="sm" variant="secondary">
						Open
					</Button>
				)}
				rowId="tools.mcp">
				<AdvancedFold featureId="tools.mcp" summary="how results show">
					<SelectRow
						options={[
							{ value: "plain", label: "Plain text" },
							{ value: "rich", label: "Rich display" },
							{ value: "markdown", label: "Markdown" },
						]}
						rowId="tools.mcp.display"
					/>
				</AdvancedFold>
			</SettingRow>
			<ToggleRow rowId="tools.web-search" />
			<SelectRow
				options={availableTerminalProfiles.map((profile) => ({ value: profile.id, label: profile.name }))}
				rowId="tools.terminal">
				<AdvancedFold featureId="tools.terminal" summary="where commands run, reuse, the wait, env vars">
					<SelectRow
						options={[
							{ value: "vscodeTerminal", label: "VS Code terminal" },
							{ value: "backgroundExec", label: "Background" },
						]}
						rowId="tools.terminal.mode"
					/>
					<NumberRow
						invalid="A positive number"
						parse={parseSeconds}
						rowId="tools.terminal.wait"
						toText={(value) => String(value / 1000)}
					/>
					<ToggleRow rowId="tools.terminal.reuse" />
					<SettingBlock rowId="tools.terminal.env">
						<div className="pt-2">
							<TerminalEnvironmentEditor />
						</div>
						<p className="m-0 mt-2 text-[11px] text-description">
							Having terminal issues? See{" "}
							<VSCodeLink href="https://docs.cline.bot/troubleshooting/terminal-quick-fixes">
								Terminal Quick Fixes
							</VSCodeLink>
							.
						</p>
					</SettingBlock>
				</AdvancedFold>
			</SelectRow>
			<div className="pt-3">
				<SettingBlock rowId="tools.worktrees">
					<WorktreeSettings />
				</SettingBlock>
			</div>
			<ToggleRow rowId="tools.hooks" />
		</>
	)
}

export const TemporaryLayoutPage = () => (
	<>
		<ToggleRow rowId="layout.one-view" />
		<SelectRow
			options={[
				{ value: "steer", label: "Steer" },
				{ value: "interject", label: "Interject" },
			]}
			rowId="layout.enter"
		/>
		<ToggleRow rowId="layout.toasts">
			<AdvancedFold featureId="layout.toasts" summary="how long they stay">
				<NumberRow invalid="1 or more, whole seconds" parse={positiveInteger} rowId="layout.toasts.seconds" />
			</AdvancedFold>
		</ToggleRow>
		<ToggleRow rowId="layout.tips" />
	</>
)

export const TemporaryDataPage = () => (
	<ToggleRow<string>
		isOn={(value) => value !== "disabled"}
		rowId="data.reporting"
		toValue={(on) => (on ? "enabled" : "disabled")}>
		<p className="m-0 mt-1 text-[11px] text-description">
			See the <VSCodeLink href="https://docs.cline.bot/more-info/telemetry">telemetry overview</VSCodeLink> and{" "}
			<VSCodeLink href="https://cline.bot/privacy">privacy policy</VSCodeLink>.
		</p>
	</ToggleRow>
)

export const TemporaryAboutPage = () => {
	const { version, extensionVariant } = useExtensionState()
	const { rows, ctx } = useSettingsShell()
	const remoteRow = findRow(rows, "about.remote-config")
	const canSeeRemoteConfig = !!remoteRow && isRowVisible(rows, remoteRow, ctx)
	return (
		<SettingBlock rowId="about.info">
			{canSeeRemoteConfig && (
				<div className="pb-1">
					<AdvancedFold featureId="about.info" summary="Remote Config">
						<SettingBlock rowId="about.remote-config">
							<RemoteConfigSection renderSectionHeader={noHeader} />
						</SettingBlock>
					</AdvancedFold>
				</div>
			)}
			<AboutSection extensionVariant={extensionVariant} renderSectionHeader={noHeader} version={version} />
		</SettingBlock>
	)
}

export const TemporaryDebugPage = () => (
	<SettingBlock rowId="debug.tools">
		<DebugSection
			onResetState={async (resetGlobalState) => {
				try {
					await StateServiceClient.resetState(ResetStateRequest.create({ global: resetGlobalState }))
				} catch (error) {
					console.error("Failed to reset state:", error)
				}
			}}
			renderSectionHeader={noHeader}
		/>
	</SettingBlock>
)
