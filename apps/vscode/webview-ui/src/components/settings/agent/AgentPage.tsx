import { languageOptions } from "@shared/Languages"
import { ABOUT_YOU_ID } from "@shared/task-groups"
import { approvalActions } from "@/components/chat/composer/approvals"
import { AboutYouMeter } from "@/components/taskGroup/AboutYouMeter"
import { notesTokens } from "@/components/taskGroup/NotebookView"
import { useTaskGroup } from "@/components/taskGroup/useTaskGroup"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutoApproveActions } from "@/hooks/useAutoApproveActions"
import { AdvancedFold } from "../shell/AdvancedFold"
import { SelectRow, SettingGroup, SettingRow, ToggleRow } from "../shell/SettingRow"

const ApprovalControls = () => {
	const { isChecked, updateAction } = useAutoApproveActions()
	return (
		<div className="grid grid-cols-5 gap-1.5 mt-3 max-w-[360px]">
			{approvalActions().map((action) => (
				<button
					aria-pressed={isChecked(action)}
					className={`flex h-12 flex-col items-center justify-center gap-1 rounded border text-[11px] ${isChecked(action) ? "border-(--vscode-focusBorder) bg-(--vscode-focusBorder)/25" : "border-transparent bg-code text-description"}`}
					key={action.id}
					onClick={() => void updateAction(action, !isChecked(action))}
					type="button">
					<i aria-hidden className={`codicon ${action.icon}`} />
					{(
						{
							readFiles: "Read",
							editFiles: "Edit",
							executeSafeCommands: "Commands",
							useBrowser: "Web",
							useMcp: "MCP",
						} as Record<string, string>
					)[action.id] ?? action.label}
				</button>
			))}
		</div>
	)
}
/** About you's notes and size, with the way into the same list and editor as task notes. */
const AboutYouSummary = () => {
	const { details } = useTaskGroup(ABOUT_YOU_ID)
	const notes = details?.notes ?? []
	return (
		<div className="mt-2 flex flex-col gap-1.5" data-testid="about-you-summary">
			{notes.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{notes.map((note) => (
						<span
							className="inline-flex max-w-40 items-center gap-1 rounded-xs border border-[color-mix(in_srgb,var(--vscode-charts-purple)_45%,transparent)] px-1.5 text-[11px] leading-4"
							key={note.slug}>
							<span className="truncate">{note.name}</span>
						</span>
					))}
				</div>
			) : (
				<span className="text-[12px] text-description">
					Nothing yet. Open it to add a note, or tell Cline “remember …” in a thread.
				</span>
			)}
			<AboutYouMeter tokens={notesTokens(notes)} />
		</div>
	)
}

const AboutYouRow = () => {
	const { navigateToTaskGroup } = useExtensionState()
	return (
		<SettingRow
			control={({ id }) => (
				<Button id={id} onClick={() => navigateToTaskGroup(ABOUT_YOU_ID, "notebook")} size="sm" variant="secondary">
					Open
				</Button>
			)}
			rowId="agent.about-you">
			<AboutYouSummary />
		</SettingRow>
	)
}

export const AgentPage = () => (
	<>
		<SettingGroup title="Approvals">
			<SettingRow rowId="agent.approvals">
				<ApprovalControls />
			</SettingRow>
		</SettingGroup>
		<SettingGroup title="In a thread">
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
		</SettingGroup>
		<SettingGroup title="General">
			<SelectRow
				options={languageOptions.map(({ display }) => ({ value: display, label: display }))}
				rowId="agent.language"
			/>
			<AboutYouRow />
			<ToggleRow rowId="agent.multi-root" />
		</SettingGroup>
	</>
)
