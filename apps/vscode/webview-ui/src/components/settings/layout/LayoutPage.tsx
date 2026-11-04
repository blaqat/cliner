import { readDock, writeDock } from "@/components/oneView/layoutPrefs"
import { useEffect, useState } from "react"
import { updateSetting } from "../utils/settingsHandlers"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AdvancedFold } from "../shell/AdvancedFold"
import { NumberRow, RowStatus, SelectRow, SettingBlock, ToggleRow } from "../shell/SettingRow"
import { findRow } from "../shell/settingsRegistry"
import { useSettingsShell } from "../shell/SettingsShellContext"

const positiveInteger = (text: string) => {
	const n = Number(text)
	return text.trim() && Number.isInteger(n) && n >= 1 ? n : undefined
}
export const LayoutPage = () => {
	const { oneViewEnabled } = useExtensionState()
	const pictureRow = findRow(useSettingsShell().rows, "layout.one-view")
	const [dock, setDock] = useState(readDock)
	useEffect(() => {
		const sync = () => setDock(readDock())
		window.addEventListener("cline:dock-changed", sync)
		window.addEventListener("storage", sync)
		return () => {
			window.removeEventListener("cline:dock-changed", sync)
			window.removeEventListener("storage", sync)
		}
	}, [])
	const selected = !oneViewEnabled ? "classic" : dock === "top" ? "tabs" : "side"
	return (
		<>
			{/* The page's own title names this. The tag's line stays reserved so the pictures don't shift. */}
			<SettingBlock rowId="layout.one-view">
				<div className="flex min-h-[18px] items-center justify-end gap-1.5">
					{pictureRow && <RowStatus row={pictureRow} />}
				</div>
				<div role="radiogroup" aria-label="Layout" className="grid grid-cols-3 gap-2 py-2">
					{[
						["classic", "Classic"],
						["side", "Side Bar"],
						["tabs", "Tab bar"],
					].map(([value, label]) => (
						<button
							type="button"
							role="radio"
							aria-checked={selected === value}
							key={value}
							className={`min-w-0 rounded border p-2 text-[11px] ${selected === value ? "border-(--vscode-focusBorder)" : "border-editor-group-border"}`}
							onClick={() => {
								if (value !== "classic") {
									const next = value === "tabs" ? "top" : "left"
									writeDock(next)
									setDock(next)
								}
								updateSetting("oneViewEnabled", value !== "classic")
							}}>
							<div
								aria-hidden
								className={`mb-2 flex h-14 gap-1 rounded border border-editor-group-border p-1 ${value === "tabs" ? "flex-col" : ""}`}>
								{value !== "classic" && (
									<div
										className={`bg-(--vscode-focusBorder)/25 ${value === "tabs" ? "h-2 w-full" : "w-1/3"}`}
									/>
								)}
								<div className="flex flex-1 flex-col justify-end gap-1">
									<div className="h-1 w-3/4 bg-description/25" />
									<div className="h-2 border border-editor-group-border" />
								</div>
							</div>
							{label}
						</button>
					))}
				</div>
			</SettingBlock>
			<SelectRow
				options={[
					{ value: "steer", label: "Steer" },
					{ value: "interject", label: "Interject" },
				]}
				rowId="layout.enter"
			/>
			<ToggleRow rowId="layout.toasts">
				<AdvancedFold featureId="layout.toasts" summary="how long they stay">
					<ToggleRow rowId="layout.toasts.system" />
					<NumberRow invalid="1 or more, whole seconds" parse={positiveInteger} rowId="layout.toasts.seconds" />
				</AdvancedFold>
			</ToggleRow>
			<ToggleRow rowId="layout.tips" />
		</>
	)
}
