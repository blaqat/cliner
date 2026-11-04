import { createContext, useContext } from "react"
import type { SettingsRow, SettingsRowContext } from "./settingsRegistry"

export interface SettingsShellValue {
	rows: readonly SettingsRow[]
	ctx: SettingsRowContext
	isFoldOpen: (featureId: string) => boolean
	toggleFold: (featureId: string) => void
	/** Opens the row's page and Advanced folds, then highlights it. */
	openRow: (rowId: string) => void
}

export const SettingsShellContext = createContext<SettingsShellValue | undefined>(undefined)

/** Rows and folds only exist inside the shell. */
export const useSettingsShell = (): SettingsShellValue => {
	const value = useContext(SettingsShellContext)
	if (!value) {
		throw new Error("useSettingsShell must be used inside SettingsShell")
	}
	return value
}
