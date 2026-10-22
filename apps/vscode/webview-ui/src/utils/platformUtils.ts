export const unknown = "Unknown"

const platforms = {
	windows: /win32/,
	mac: /darwin/,
	linux: /linux/,
}

export const detectOS = (platform: string) => {
	let detectedOs = unknown
	if (platform.match(platforms.windows)) {
		detectedOs = "windows"
	} else if (platform.match(platforms.mac)) {
		detectedOs = "mac"
	} else if (platform.match(platforms.linux)) {
		detectedOs = "linux"
	}
	return detectedOs
}

// Label for the platform "mod" key used by shortcuts: Cmd on macOS, Ctrl on
// Windows/Linux (the OS captures the Win/Super key, so it can never be a
// usable webview shortcut).
export const detectMetaKeyChar = (platform: string) => {
	return platform.match(platforms.mac) ? "⌘" : "Ctrl"
}

const userAgent = navigator?.userAgent || ""

const isChrome = userAgent.indexOf("Chrome") >= 0

export const isSafari = !isChrome && userAgent.indexOf("Safari") >= 0

declare const __NODE_PLATFORM__: string

type Platform = "windows" | "mac" | "linux"

/**
 * The OS the webview is running on right now, from the browser. Checked before the build-time
 * value: that one is the machine the extension was *built* on, so a vsix built on a Mac would
 * otherwise show ⌘ and listen for Cmd on Windows. Mac is checked first because "darwin" contains
 * "win".
 */
function runtimePlatform(): Platform | undefined {
	if (typeof navigator === "undefined") return undefined
	const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
	const hint = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`.toLowerCase()
	if (/mac|darwin|iphone|ipad/.test(hint)) return "mac"
	if (/win/.test(hint)) return "windows"
	if (/linux|x11|cros/.test(hint)) return "linux"
	return undefined
}

/**
 * Gets the current platform: 'windows', 'mac', or 'linux' (where the keyboard is, even in a
 * remote window). Falls back to the build machine's, then to 'linux'.
 */
export function getCurrentPlatform(): Platform {
	const detected = runtimePlatform()
	if (detected) return detected
	switch (__NODE_PLATFORM__) {
		case "win32":
			return "windows"
		case "darwin":
			return "mac"
		default:
			return "linux"
	}
}

/** Cmd on macOS, Ctrl elsewhere: the label for "Meta" in shortcuts. */
export const modKeyLabel = (): string => (getCurrentPlatform() === "mac" ? "⌘" : "Ctrl")

/**
 * Checks if the platform is macOS or Linux
 * @returns true if platform is darwin (macOS) or linux
 */
export const isMacOSOrLinux = (): boolean => {
	return getCurrentPlatform() !== "windows" // Non-Windows
}
