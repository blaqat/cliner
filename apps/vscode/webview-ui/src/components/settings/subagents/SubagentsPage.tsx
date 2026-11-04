import { useSettingsShell } from "../shell/SettingsShellContext"
import { findRow, isRowManaged, writeRow } from "../shell/settingsRegistry"
import type { AllowedSubagentModel, SubagentPick } from "@shared/model-settings"
import { ModelPickButton } from "@/components/models/ModelPickButton"
import { selectorDataFromModelSettings, sameAsThreadRow } from "@/components/models/modelSelectorRows"
import type { SelectorPick } from "@/components/models/ModelSelector"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { Button } from "@/components/ui/button"
import { AdvancedFold } from "../shell/AdvancedFold"
import { NumberRow, SelectRow, SettingRow, SettingBlock, RowStatus, ToggleRow } from "../shell/SettingRow"
export function SubagentsPage() {
	const { modelSettings, navigateToSettings } = useExtensionState()
	const { rows: registry, ctx } = useSettingsShell()
	if (!modelSettings) return null
	const data = selectorDataFromModelSettings(modelSettings)
	const rows = [sameAsThreadRow(data.ladder), ...data.rows]
	const manage = () => navigateToSettings("models")
	const allowedPick = (p: SelectorPick): AllowedSubagentModel =>
		p.rowId === "thread" ? { kind: "thread", levels: [p.levelId] } : { kind: "model", modelId: p.rowId, levels: [p.levelId] }
	return (
		<>
			<ToggleRow rowId="subagents.enabled" />
			<SettingRow<SubagentPick>
				rowId="subagents.default"
				control={({ value, write, disabled }) => (
					<ModelPickButton
						{...data}
						rows={rows}
						modelsLabel="Default subagent"
						pick={
							value.kind === "thread"
								? { rowId: "thread", levelId: value.level }
								: { rowId: value.pick.modelId, levelId: value.pick.levelId }
						}
						onManage={manage}
						disabledReason={disabled ? "Turn on Subagents above to pick a default." : undefined}
						onCommit={(p) =>
							write(
								p.rowId === "thread"
									? { kind: "thread", level: p.levelId }
									: { kind: "model", pick: { modelId: p.rowId, levelId: p.levelId } },
							)
						}
					/>
				)}>
				<AdvancedFold featureId="subagents.default" summary="models the parent can choose">
					<SettingRow<AllowedSubagentModel[]>
						rowId="subagents.allowed"
						control={({ value, write, disabled }) => (
							<div className="flex flex-col gap-2">
								{value.map((entry, index) => {
									const rowId = entry.kind === "thread" ? "thread" : entry.modelId
									const levels = rows.find((r) => r.id === rowId)?.levels ?? [
										{ id: "default", label: "Default" },
									]
									return (
										<div className="flex flex-wrap items-center gap-2" key={`${rowId}-${index}`}>
											<ModelPickButton
												{...data}
												rows={rows}
												modelsLabel="Edit allowed model"
												pick={{ rowId, levelId: entry.levels[0] ?? "default" }}
												onManage={manage}
												disabledReason={disabled ? "Turn on Subagents above." : undefined}
												onCommit={(p) => write(value.map((a, i) => (i === index ? allowedPick(p) : a)))}
											/>
											{levels.map((level) => (
												<label className="text-[11px]" key={level.id}>
													<input
														type="checkbox"
														checked={entry.levels.includes(level.id)}
														disabled={disabled}
														onChange={(e) => {
															const next = e.target.checked
																? [...entry.levels, level.id]
																: entry.levels.filter((id) => id !== level.id)
															if (next.length)
																write(
																	value.map((a, i) =>
																		i === index ? { ...a, levels: next } : a,
																	),
																)
														}}
													/>
													{level.label}
												</label>
											))}
											<Button
												disabled={disabled}
												size="sm"
												variant="ghost"
												onClick={() => write(value.filter((_, i) => i !== index))}>
												Remove
											</Button>
										</div>
									)
								})}
								<ModelPickButton
									{...data}
									rows={rows.filter(
										(r) => !value.some((a) => (a.kind === "thread" ? r.id === "thread" : a.modelId === r.id)),
									)}
									modelsLabel="Add allowed model"
									pick={null}
									onManage={manage}
									disabledReason={disabled ? "Turn on Subagents above to edit the list." : undefined}
									onCommit={(p) => write([...value, allowedPick(p)])}
								/>
							</div>
						)}
					/>
				</AdvancedFold>
			</SettingRow>
			<NumberRow
				rowId="subagents.cap"
				parse={(text) => {
					const n = Number(text)
					return text.trim() && Number.isInteger(n) && n >= 0 ? n : undefined
				}}
				invalid="A whole number, 0 for unlimited"
			/>
			<p className="text-[11px] text-description">
				They may. Reading and searching are always allowed. Never more access than the thread has.
			</p>
			<div className="grid grid-cols-4 gap-1 max-w-[330px]">
				{(
					[
						["write", "Edit", "edit"],
						["commands", "Commands", "terminal"],
						["web", "Web", "globe"],
						["mcp", "MCP", "plug"],
					] as const
				).map(([key, label, icon]) => {
					const row = findRow(registry, `subagents.access.${key}`)!
					const checked = modelSettings.settings.subagents.access[key]
					const disabled = isRowManaged(row, ctx) || !modelSettings.settings.subagents.enabled
					return (
						<SettingBlock key={key} rowId={row.id}>
							<button
								type="button"
								aria-label={label}
								aria-pressed={checked}
								disabled={disabled}
								onClick={() => {
									if (row.kind === "preference") writeRow(row, !checked, ctx)
								}}
								className={`flex h-11 w-full flex-col items-center justify-center gap-1 rounded border text-[10px] disabled:opacity-50 ${checked ? "border-(--vscode-focusBorder)/60 bg-(--vscode-focusBorder)/25" : "border-transparent bg-code text-description"}`}>
								<i aria-hidden className={`codicon codicon-${icon}`} />
								{label}
							</button>
							<div className="flex flex-wrap gap-1 mt-1">
								<RowStatus row={row} />
							</div>
						</SettingBlock>
					)
				})}
			</div>
			<SelectRow
				rowId="subagents.blocking"
				options={[
					{ value: "never", label: "Never" },
					{ value: "parent-decides", label: "Parent decides" },
					{ value: "always", label: "Always wait" },
				]}
			/>
		</>
	)
}
