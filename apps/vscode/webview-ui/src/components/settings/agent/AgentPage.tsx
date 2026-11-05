import { languageOptions } from "@shared/Languages"
import { approvalActions } from "@/components/chat/composer/approvals"
import { useAutoApproveActions } from "@/hooks/useAutoApproveActions"
import { AdvancedFold } from "../shell/AdvancedFold"
import { NumberRow, SelectRow, SettingGroup, SettingRow, ToggleRow } from "../shell/SettingRow"

const positiveInteger = (text: string) => {
	const n = Number(text)
	return text.trim() && Number.isInteger(n) && n >= 1 ? n : undefined
}
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
			<ToggleRow rowId="agent.progress">
				<AdvancedFold featureId="agent.progress" summary="reminders">
					<NumberRow invalid="1 or more messages" parse={positiveInteger} rowId="agent.progress.interval" />
				</AdvancedFold>
			</ToggleRow>
		</SettingGroup>
		<SettingGroup title="General">
			<SelectRow
				options={languageOptions.map(({ display }) => ({ value: display, label: display }))}
				rowId="agent.language"
			/>
			<ToggleRow rowId="agent.multi-root" />
		</SettingGroup>
	</>
)
