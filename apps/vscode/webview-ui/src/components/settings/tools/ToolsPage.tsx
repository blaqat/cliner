import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { toggleTopBarPanel } from "@/components/topbar/topBarPanels"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { WorktreeSettings } from "@/components/worktrees/WorktreeSettings"
import { useExtensionState } from "@/context/ExtensionStateContext"
import TerminalEnvironmentEditor from "../environment/TerminalEnvironmentEditor"
import { AdvancedFold } from "../shell/AdvancedFold"
import { NumberRow, SelectRow, SettingBlock, SettingGroup, SettingRow, ToggleRow } from "../shell/SettingRow"

export const ToolsPage = () => {
	const { availableTerminalProfiles, navigateToMcp, worktreesEnabled } = useExtensionState()
	const parseSeconds = (text: string) => {
		const seconds = Number.parseFloat(text)
		return Number.isNaN(seconds) || seconds <= 0 ? undefined : Math.round(seconds * 1000)
	}
	return (
		<>
			<SettingGroup title="MCP and rules">
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
					control={({ id }) => (
						<Button id={id} onClick={() => toggleTopBarPanel("rules")} size="sm" variant="secondary">
							Manage
						</Button>
					)}
					rowId="tools.rules"
				/>
			</SettingGroup>
			<SettingGroup title="Web">
				<ToggleRow rowId="tools.web-search" />
				<ToggleRow rowId="tools.browser">
					<AdvancedFold featureId="tools.browser" summary="Chrome, viewport, remote browser">
						{["chromeExecutablePath", "customArgs", "remoteBrowserHost"].map((key) => (
							<SettingRow<string>
								control={({ value, write, id, disabled }) => (
									<Input
										className="h-6 w-40"
										defaultValue={value}
										disabled={disabled}
										id={id}
										onBlur={(e) => {
											if (e.target.value !== value) write(e.target.value)
										}}
									/>
								)}
								key={key}
								rowId={`tools.browser.${key}`}
							/>
						))}
						<SelectRow
							options={["1280x800", "900x600", "768x1024", "360x640"].map((value) => ({ value, label: value }))}
							rowId="tools.browser.viewport"
						/>
						<ToggleRow rowId="tools.browser.remote" />
					</AdvancedFold>
				</ToggleRow>
			</SettingGroup>
			<SettingGroup title="Terminal">
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
							<p className="m-0 mt-2 text-[12px] text-description">
								Having terminal issues? See{" "}
								<VSCodeLink href="https://docs.cline.bot/troubleshooting/terminal-quick-fixes">
									Terminal Quick Fixes
								</VSCodeLink>
								.
							</p>
						</SettingBlock>
					</AdvancedFold>
				</SelectRow>
			</SettingGroup>
			<SettingGroup title="Worktrees and hooks">
				<SettingRow rowId="tools.worktrees">
					{worktreesEnabled?.featureFlag ? (
						<WorktreeSettings />
					) : (
						<p className="text-[12px] text-description">
							Worktrees are unavailable in this build. Update the extension to configure them.
						</p>
					)}
				</SettingRow>
				<ToggleRow rowId="tools.hooks" />
			</SettingGroup>
		</>
	)
}
