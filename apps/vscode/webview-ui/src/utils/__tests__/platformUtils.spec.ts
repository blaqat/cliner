import { afterEach, describe, expect, it, vi } from "vitest"
import { detectMetaKeyChar, getCurrentPlatform, modKeyLabel } from "../platformUtils"

describe("detectMetaKeyChar", () => {
	it("should return ⌘ for darwin platform", () => {
		const result = detectMetaKeyChar("darwin")
		expect(result).toBe("⌘")
	})

	it("should return Ctrl for win32 platform", () => {
		const result = detectMetaKeyChar("win32")
		expect(result).toBe("Ctrl")
	})

	it("should return Ctrl for linux platform", () => {
		const result = detectMetaKeyChar("linux")
		expect(result).toBe("Ctrl")
	})

	it("should return Ctrl for unknown platform", () => {
		const result = detectMetaKeyChar("somethingelse")
		expect(result).toBe("Ctrl")
	})
})

describe("getCurrentPlatform", () => {
	afterEach(() => vi.unstubAllGlobals())
	const on = (userAgent: string, platform = "") => vi.stubGlobal("navigator", { userAgent, platform })

	// The build machine's value would say "mac" for a vsix built on a Mac and installed on Windows.
	it("reads the OS the webview runs on, not the one it was built on", () => {
		on("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Code/1.105.0 Chrome/138 Electron/37", "Win32")
		expect(getCurrentPlatform()).toBe("windows")
		expect(modKeyLabel()).toBe("Ctrl")
		on("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Code/1.105.0", "MacIntel")
		expect(getCurrentPlatform()).toBe("mac")
		expect(modKeyLabel()).toBe("⌘")
		on("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Code/1.105.0", "Linux x86_64")
		expect(getCurrentPlatform()).toBe("linux")
		expect(modKeyLabel()).toBe("Ctrl")
	})

	it("doesn't read darwin as Windows", () => {
		on("Mozilla/5.0 (darwin) jsdom")
		expect(getCurrentPlatform()).toBe("mac")
	})
})
