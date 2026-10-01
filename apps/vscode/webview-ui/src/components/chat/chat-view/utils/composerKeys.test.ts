import { describe, expect, it } from "vitest"
import { resolveSubmitKey, type SubmitKeyEvent } from "./composerKeys"

const key = (overrides: Partial<SubmitKeyEvent> = {}): SubmitKeyEvent => ({
	key: "Enter",
	shiftKey: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	...overrides,
})

describe("resolveSubmitKey", () => {
	it("sends normally when idle, whatever the modifier", () => {
		expect(resolveSubmitKey(key(), { running: false, enterSendsAs: "steer" })).toBe("send")
		expect(resolveSubmitKey(key({ ctrlKey: true }), { running: false, enterSendsAs: "interject" })).toBe("send")
	})

	it("follows enterSendsAs while running and swaps with Ctrl/Cmd+Enter", () => {
		expect(resolveSubmitKey(key(), { running: true, enterSendsAs: "steer" })).toBe("steer")
		expect(resolveSubmitKey(key({ ctrlKey: true }), { running: true, enterSendsAs: "steer" })).toBe("interject")
		expect(resolveSubmitKey(key({ metaKey: true }), { running: true, enterSendsAs: "steer" })).toBe("interject")
		expect(resolveSubmitKey(key(), { running: true, enterSendsAs: "interject" })).toBe("interject")
		expect(resolveSubmitKey(key({ metaKey: true }), { running: true, enterSendsAs: "interject" })).toBe("steer")
	})

	it("sends Alt+Enter as an aside, running or not", () => {
		expect(resolveSubmitKey(key({ altKey: true }), { running: false, enterSendsAs: "steer" })).toBe("aside")
		expect(resolveSubmitKey(key({ altKey: true, ctrlKey: true }), { running: true, enterSendsAs: "steer" })).toBe("aside")
	})

	it("starts a background chat on Ctrl/Cmd+Enter from the home composer", () => {
		expect(resolveSubmitKey(key({ ctrlKey: true }), { running: false, enterSendsAs: "steer", onHome: true })).toBe(
			"background",
		)
		expect(resolveSubmitKey(key({ metaKey: true }), { running: false, enterSendsAs: "interject", onHome: true })).toBe(
			"background",
		)
	})

	it("keeps Enter and Alt+Enter unchanged on the home composer", () => {
		expect(resolveSubmitKey(key(), { running: false, enterSendsAs: "steer", onHome: true })).toBe("send")
		expect(
			resolveSubmitKey(key({ altKey: true, ctrlKey: true }), { running: false, enterSendsAs: "steer", onHome: true }),
		).toBe("aside")
	})

	it("does not change Ctrl/Cmd+Enter inside a chat", () => {
		expect(resolveSubmitKey(key({ ctrlKey: true }), { running: true, enterSendsAs: "steer", onHome: false })).toBe(
			"interject",
		)
		expect(resolveSubmitKey(key({ ctrlKey: true }), { running: true, enterSendsAs: "steer" })).toBe("interject")
		expect(resolveSubmitKey(key({ ctrlKey: true }), { running: false, enterSendsAs: "steer", onHome: false })).toBe("send")
	})

	it("ignores Shift+Enter and other keys", () => {
		expect(resolveSubmitKey(key({ shiftKey: true }), { running: true, enterSendsAs: "steer" })).toBeNull()
		expect(resolveSubmitKey(key({ key: "a" }), { running: true, enterSendsAs: "steer" })).toBeNull()
	})
})
