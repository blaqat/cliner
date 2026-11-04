import { approvalActions } from "@/components/chat/composer/approvals"
import { useAutoApproveActions } from "@/hooks/useAutoApproveActions"
import { languageOptions } from "@shared/Languages"
import { AdvancedFold } from "../shell/AdvancedFold"
import { NumberRow, SelectRow, SettingRow, ToggleRow } from "../shell/SettingRow"

const positiveInteger = (text: string) => {
	const n = Number(text)
	return text.trim() && Number.isInteger(n) && n >= 1 ? n : undefined
}
const ApprovalControls = () => {
	const { isChecked, updateAction } = useAutoApproveActions()
	return (
		<div className="grid grid-cols-5 gap-1 mt-2 max-w-[330px]">
			{approvalActions().map((action) => (
				<button
					type="button"
					aria-pressed={isChecked(action)}
					key={action.id}
					onClick={() => void updateAction(action, !isChecked(action))}
					className={`flex h-11 flex-col items-center justify-center rounded border text-[10px] ${isChecked(action) ? "border-(--vscode-focusBorder) bg-(--vscode-focusBorder)/25" : "border-transparent bg-code text-description"}`}>
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
		<SettingRow rowId="agent.approvals">
			<ApprovalControls />
		</SettingRow>
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
		<ToggleRow rowId="agent.progress">
			<AdvancedFold featureId="agent.progress" summary="reminders">
				<NumberRow rowId="agent.progress.interval" parse={positiveInteger} invalid="1 or more messages" />
			</AdvancedFold>
		</ToggleRow>
		<ToggleRow rowId="agent.multi-root" />
	</>
)
