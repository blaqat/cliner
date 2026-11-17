import { createContext, type ReactNode, useContext } from "react"

export interface OneViewState {
	/** The one-view layout is on: headers drop the Home crumb (the list is home). */
	enabled: boolean
	/** Hide/show button for the side list, for the far left of the header; null when the list is the top strip. */
	listToggle: ReactNode
}

const CLASSIC: OneViewState = { enabled: false, listToggle: null }

export const OneViewContext = createContext<OneViewState>(CLASSIC)

/** One view's header controls; the classic layout (no provider) gets `enabled: false`. */
export function useOneView(): OneViewState {
	return useContext(OneViewContext)
}
