import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { detectMetaKeyChar, detectOS, getCurrentPlatform, unknown } from "./platformUtils"

export const useMetaKeyDetection = (platform: string) => {
	const [metaKeyChar, setMetaKeyChar] = useState(unknown)
	const [os, setOs] = useState(unknown)

	useEffect(() => {
		const detectedMetaKeyChar = detectMetaKeyChar(platform)
		const detectedOs = detectOS(platform)
		setMetaKeyChar(detectedMetaKeyChar)
		setOs(detectedOs)
	}, [platform])

	return [os, metaKeyChar]
}

export const useShortcut = (shortcut: string, callback: (...args: unknown[]) => void, options = { disableTextInputs: true }) => {
	const callbackRef = useRef(callback)
	const [keyCombo, setKeyCombo] = useState<string[]>([])

	useLayoutEffect(() => {
		callbackRef.current = callback
	})

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			const isTextInput =
				event.target instanceof HTMLTextAreaElement ||
				(event.target instanceof HTMLInputElement && (!event.target.type || event.target.type === "text")) ||
				(event.target as HTMLElement).isContentEditable

			// "Meta" in a shortcut means the platform mod key: Cmd on macOS,
			// Ctrl on Windows/Linux (where the Win/Super key is captured by the
			// OS and never reaches the webview).
			const modifierMap: { [key: string]: boolean } = {
				Control: event.ctrlKey,
				Alt: event.altKey,
				Meta: getCurrentPlatform() === "mac" ? event.metaKey : event.ctrlKey || event.metaKey,
				Shift: event.shiftKey,
			}

			if (event.repeat) {
				return null
			}

			if (options.disableTextInputs && isTextInput) {
				return event.stopPropagation()
			}

			if (shortcut.includes("+")) {
				const keyArray = shortcut.split("+")

				if (Object.keys(modifierMap).includes(keyArray[0])) {
					const finalKey = keyArray.pop()
					if (!finalKey) {
						return
					}

					if (keyArray.every((k) => modifierMap[k]) && finalKey.toLowerCase() === event.key.toLowerCase()) {
						event.preventDefault()
						return callbackRef.current(event)
					}
				} else {
					if (keyArray[keyCombo.length] === event.key) {
						if (keyArray[keyArray.length - 1] === event.key && keyCombo.length === keyArray.length - 1) {
							callbackRef.current(event)
							return setKeyCombo([])
						}

						return setKeyCombo((prevCombo) => [...prevCombo, event.key])
					}
					if (keyCombo.length > 0) {
						return setKeyCombo([])
					}
				}
			}

			if (shortcut === event.key) {
				return callbackRef.current(event)
			}
		},
		[keyCombo.length, options.disableTextInputs, shortcut],
	)

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown)

		return () => {
			window.removeEventListener("keydown", handleKeyDown)
		}
	}, [handleKeyDown])
}
