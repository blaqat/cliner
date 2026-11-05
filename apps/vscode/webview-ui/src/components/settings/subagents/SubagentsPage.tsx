import type { AllowedSubagentModel, SubagentPick } from "@shared/model-settings"
import { ModelPickButton } from "@/components/models/ModelPickButton"
import type { SelectorPick } from "@/components/models/ModelSelector"
import { sameAsThreadRow, selectorDataFromModelSettings } from "@/components/models/modelSelectorRows"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import type { SettingsNavigationTarget } from "../settingsTargets"
import { AdvancedFold } from "../shell/AdvancedFold"
import { NumberRow, RowStatus, SelectRow, SettingBlock, SettingGroup, SettingRow, ToggleRow } from "../shell/SettingRow"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { findRow, isRowManaged, writeRow } from "../shell/settingsRegistry"
export function SubagentsPage() {
	const { modelSettings, navigateToSettings } = useExtensionState()
	const { rows: registry, ctx } = useSettingsShell()
	if (!modelSettings) return null
	const data = selectorDataFromModelSettings(modelSettings)
	const rows = [sameAsThreadRow(data.ladder), ...data.rows]
	const manage = (target?: SettingsNavigationTarget) => navigateToSettings(target ?? "models")
	const allowedPick = (p: SelectorPick): AllowedSubagentModel =>
		p.rowId === "thread" ? { kind: "thread", levels: [p.levelId] } : { kind: "model", modelId: p.rowId, levels: [p.levelId] }
	return (
		<>
			<SettingGroup>
				<ToggleRow rowId="subagents.enabled" />
				<SettingRow<SubagentPick>
					control={({ value, write, disabled }) => (
						<ModelPickButton
							{...data}
							disabledReason={disabled ? "Turn on Subagents above to pick a default." : undefined}
							modelsLabel="Default subagent"
							onCommit={(p) =>
								write(
									p.rowId === "thread"
										? { kind: "thread", level: p.levelId }
										: { kind: "model", pick: { modelId: p.rowId, levelId: p.levelId } },
								)
							}
							onManage={manage}
							pick={
								value.kind === "thread"
									? { rowId: "thread", levelId: value.level }
									: { rowId: value.pick.modelId, levelId: value.pick.levelId }
							}
							rows={rows}
						/>
					)}
					rowId="subagents.default">
					<AdvancedFold featureId="subagents.default" summary="models the parent can choose">
						<SettingRow<AllowedSubagentModel[]>
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
													disabledReason={disabled ? "Turn on Subagents above." : undefined}
													modelsLabel="Edit allowed model"
													onCommit={(p) =>
														write(value.map((a, i) => (i === index ? allowedPick(p) : a)))
													}
													onManage={manage}
													pick={{ rowId, levelId: entry.levels[0] ?? "default" }}
													rows={rows}
												/>
												{levels.map((level) => (
													<label className="text-[12px]" key={level.id}>
														<input
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
															type="checkbox"
														/>
														{level.label}
													</label>
												))}
												<Button
													disabled={disabled}
													onClick={() => write(value.filter((_, i) => i !== index))}
													size="sm"
													variant="ghost">
													Remove
												</Button>
											</div>
										)
									})}
									<ModelPickButton
										{...data}
										disabledReason={disabled ? "Turn on Subagents above to edit the list." : undefined}
										modelsLabel="Add allowed model"
										onCommit={(p) => write([...value, allowedPick(p)])}
										onManage={manage}
										pick={null}
										rows={rows.filter(
											(r) =>
												!value.some((a) =>
													a.kind === "thread" ? r.id === "thread" : a.modelId === r.id,
												),
										)}
									/>
								</div>
							)}
							rowId="subagents.allowed"
						/>
					</AdvancedFold>
				</SettingRow>
				<NumberRow
					invalid="A whole number, 0 for unlimited"
					parse={(text) => {
						const n = Number(text)
						return text.trim() && Number.isInteger(n) && n >= 0 ? n : undefined
					}}
					rowId="subagents.cap"
				/>
				<SelectRow
					options={[
						{ value: "never", label: "Never" },
						{ value: "parent-decides", label: "Parent decides" },
						{ value: "always", label: "Always wait" },
					]}
					rowId="subagents.blocking"
				/>
			</SettingGroup>
			<SettingGroup title="They may">
				<div className="px-4 py-3.5">
					<p className="m-0 mb-3 text-[12px] leading-[1.45] text-description">
						Reading and searching are always allowed. Never more access than the thread has.
					</p>
					<div className="grid grid-cols-4 gap-1.5 max-w-[360px]">
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
										aria-label={label}
										aria-pressed={checked}
										className={`flex h-12 w-full flex-col items-center justify-center gap-1 rounded border text-[11px] disabled:opacity-50 ${checked ? "border-(--vscode-focusBorder)/60 bg-(--vscode-focusBorder)/25" : "border-transparent bg-code text-description"}`}
										disabled={disabled}
										onClick={() => {
											if (row.kind === "preference") writeRow(row, !checked, ctx)
										}}
										type="button">
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
				</div>
			</SettingGroup>
		</>
	)
}
