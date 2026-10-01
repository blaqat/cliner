import { renderHook } from "@testing-library/react"
import { vi } from "vitest"
import { useMetaKeyDetection, useShortcut } from "../hooks"

// useShortcut resolves "Meta" through getCurrentPlatform; swap it per test.
const platformMock = vi.hoisted(() => ({ current: "darwin" }))
vi.mock("../platformUtils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../platformUtils")>()
	return { ...actual, getCurrentPlatform: () => platformMock.current }
})

describe("useShortcut", () => {
	it("should call the callback when the shortcut is pressed", () => {
		platformMock.current = "darwin"
		const callback = vi.fn()
		renderHook(() => useShortcut("Meta+Shift+a", callback))

		const event = new KeyboardEvent("keydown", { key: "a", metaKey: true, shiftKey: true })
		window.dispatchEvent(event)

		expect(callback).toHaveBeenCalled()
	})

	it("should map Meta to Ctrl on Windows/Linux", () => {
		platformMock.current = "win32"
		const callback = vi.fn()
		renderHook(() => useShortcut("Meta+Shift+a", callback))

		// Ctrl+Shift+A triggers it...
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, shiftKey: true }))
		expect(callback).toHaveBeenCalledTimes(1)

		// ...and the bare Meta (Win/Super) modifier does too if it ever arrives.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, shiftKey: true }))
		expect(callback).toHaveBeenCalledTimes(2)

		// But plain Shift+A without the mod key does not.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", shiftKey: true }))
		expect(callback).toHaveBeenCalledTimes(2)
		platformMock.current = "darwin"
	})

	it("should not call the callback when the shortcut is not pressed", () => {
		const callback = vi.fn()
		renderHook(() => useShortcut("Command+Shift+b", callback))

		const event = new KeyboardEvent("keydown", { key: "a", metaKey: true, shiftKey: true })
		window.dispatchEvent(event)

		expect(callback).not.toHaveBeenCalled()
	})

	it("should not call the callback when typing in a text input when disableTextInputs is true", () => {
		const callback = vi.fn()
		renderHook(() => useShortcut("Meta+Shift+a", callback, { disableTextInputs: true }))

		const input = document.createElement("input")
		document.body.appendChild(input)
		input.focus()

		const event = new KeyboardEvent("keydown", { key: "a", metaKey: true, shiftKey: true })
		input.dispatchEvent(event)

		expect(callback).not.toHaveBeenCalled()

		document.body.removeChild(input)
	})
})

describe("useMetaKeyDetection", () => {
	it("should detect Windows OS and metaKey from platform", () => {
		// mock the detect functions
		const { result } = renderHook(() => useMetaKeyDetection("win32"))
		expect(result.current[0]).toBe("windows")
		expect(result.current[1]).toBe("Ctrl")
	})

	it("should detect Mac OS and metaKey from platform", () => {
		// mock the detect functions
		const { result } = renderHook(() => useMetaKeyDetection("darwin"))
		expect(result.current[0]).toBe("mac")
		expect(result.current[1]).toBe("⌘")
	})

	it("should detect Linux OS and metaKey from platform", () => {
		// mock the detect functions
		const { result } = renderHook(() => useMetaKeyDetection("linux"))
		expect(result.current[0]).toBe("linux")
		expect(result.current[1]).toBe("Ctrl")
	})
})
