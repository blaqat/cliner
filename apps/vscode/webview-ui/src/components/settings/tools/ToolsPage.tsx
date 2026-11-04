import { toggleTopBarPanel } from "@/components/topbar/topBarPanels"
import { Input } from "@/components/ui/input"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { WorktreeSettings } from "@/components/worktrees/WorktreeSettings"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import TerminalEnvironmentEditor from "../environment/TerminalEnvironmentEditor"
import { AdvancedFold } from "../shell/AdvancedFold"
import { NumberRow, SelectRow, SettingBlock, SettingRow, ToggleRow } from "../shell/SettingRow"

export const ToolsPage = () => {
	const { availableTerminalProfiles, navigateToMcp, worktreesEnabled } = useExtensionState()
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
				<AdvancedFold featureId="tools.mcp" summary="marketplace, results">
					<ToggleRow rowId="tools.mcp.marketplace" />
					<ToggleRow rowId="tools.mcp.collapsed" />
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
			<SettingRow
				rowId="tools.rules"
				control={({ id }) => (
					<Button id={id} size="sm" variant="secondary" onClick={() => toggleTopBarPanel("rules")}>
						Manage
					</Button>
				)}
			/>
			<ToggleRow rowId="tools.web-search" />
			<ToggleRow rowId="tools.browser">
				<AdvancedFold featureId="tools.browser" summary="Chrome, viewport, remote browser">
					{["chromeExecutablePath", "customArgs", "remoteBrowserHost"].map((key) => (
						<SettingRow<string>
							key={key}
							rowId={`tools.browser.${key}`}
							control={({ value, write, id, disabled }) => (
								<Input
									className="h-6 w-40"
									id={id}
									disabled={disabled}
									defaultValue={value}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
						/>
					))}
					<SelectRow
						rowId="tools.browser.viewport"
						options={["1280x800", "900x600", "768x1024", "360x640"].map((value) => ({ value, label: value }))}
					/>
					<ToggleRow rowId="tools.browser.remote" />
				</AdvancedFold>
			</ToggleRow>
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
				<SettingRow rowId="tools.worktrees">
					{worktreesEnabled?.featureFlag ? (
						<WorktreeSettings />
					) : (
						<p className="text-[11px] text-description">
							Worktrees are unavailable in this build. Update the extension to configure them.
						</p>
					)}
				</SettingRow>
			</div>
			<ToggleRow rowId="tools.hooks" />
		</>
	)
}
