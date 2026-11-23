import { useEffect, useRef } from "react"

/**
 * Open menus close on an outside click, but some clicks never reach this page: the view's title bar
 * buttons (Settings, History, +, MCP, Rules) are VS Code's, and they keep focus where it was, so no
 * pointer or focus event lands here. Those buttons, a view change, and the page losing focus call
 * {@link dismissMenus} instead, which closes every open menu that listens with {@link useDismissOnLeave}.
 */
const DISMISS_EVENT = "cline:dismiss-menus"

export function dismissMenus(): void {
	window.dispatchEvent(new Event(DISMISS_EVENT))
}

/** Calls `onDismiss` while `open` when another view takes over or the page loses focus. */
export function useDismissOnLeave(open: boolean, onDismiss: () => void): void {
	const dismissRef = useRef(onDismiss)
	dismissRef.current = onDismiss
	useEffect(() => {
		if (!open) return
		const dismiss = () => dismissRef.current()
		const onVisibility = () => {
			if (document.visibilityState === "hidden") dismiss()
		}
		window.addEventListener(DISMISS_EVENT, dismiss)
		window.addEventListener("blur", dismiss)
		document.addEventListener("visibilitychange", onVisibility)
		return () => {
			window.removeEventListener(DISMISS_EVENT, dismiss)
			window.removeEventListener("blur", dismiss)
			document.removeEventListener("visibilitychange", onVisibility)
		}
	}, [open])
}
