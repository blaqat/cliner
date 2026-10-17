import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	buildApiHandler: vi.fn(),
	createMessage: vi.fn(),
}))

vi.mock("./sdk-api-handler", () => ({
	buildApiHandler: mocks.buildApiHandler,
}))

import { maybeGenerateThreadTitle, sanitizeThreadTitle, type ThreadTitleDeps } from "./thread-title"

function streamOf(text: string, error?: string) {
	return (async function* () {
		if (text) yield { type: "text", text }
		yield { type: "done", success: !error, error }
	})()
}

function makeStore(settings: Record<string, unknown>) {
	return {
		getGlobalStateKey: (key: string) => settings[key],
		setGlobalStateBatch: vi.fn(),
		getApiConfiguration: () => ({ actModeApiProvider: "anthropic", actModeApiModelId: "claude-x", apiKey: "k" }),
		setApiConfiguration: vi.fn(),
		getSecretForKey: vi.fn(() => undefined),
		setSecretsForKeys: vi.fn(),
		listSecretStorageKeys: vi.fn(() => []),
	}
}

function makeDeps(settings: Record<string, unknown>, titleState: { hasTitle: boolean; generated: boolean }) {
	const applyTitle = vi.fn(async () => true)
	const deps: ThreadTitleDeps = {
		store: makeStore(settings) as never,
		getTitleState: vi.fn(async () => titleState),
		applyTitle,
	}
	return { deps, applyTitle }
}

describe("maybeGenerateThreadTitle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.buildApiHandler.mockReturnValue({ createMessage: mocks.createMessage })
		mocks.createMessage.mockReturnValue(streamOf("Fix the flaky login redirect test"))
	})

	it("does nothing when the toggle is off (the default)", async () => {
		const { deps, applyTitle } = makeDeps({}, { hasTitle: false, generated: false })
		await maybeGenerateThreadTitle(deps, "t1", "fix the flaky login test")
		expect(mocks.buildApiHandler).not.toHaveBeenCalled()
		expect(applyTitle).not.toHaveBeenCalled()
	})

	it("generates and applies a title once the feature is enabled", async () => {
		const { deps, applyTitle } = makeDeps({ threadTitlesEnabled: true }, { hasTitle: false, generated: false })
		await maybeGenerateThreadTitle(deps, "t1", "fix the flaky login test")
		expect(mocks.createMessage).toHaveBeenCalledTimes(1)
		expect(applyTitle).toHaveBeenCalledWith("t1", "Fix the flaky login redirect test")
	})

	it("skips the model call when the thread already has a title", async () => {
		const { deps } = makeDeps({ threadTitlesEnabled: true }, { hasTitle: true, generated: false })
		await maybeGenerateThreadTitle(deps, "t1", "first message")
		expect(mocks.buildApiHandler).not.toHaveBeenCalled()
	})

	it("skips the model call when generation already ran", async () => {
		const { deps } = makeDeps({ threadTitlesEnabled: true }, { hasTitle: false, generated: true })
		await maybeGenerateThreadTitle(deps, "t1", "first message")
		expect(mocks.buildApiHandler).not.toHaveBeenCalled()
	})

	it("does not write when the guarded apply refuses (user set a title meanwhile)", async () => {
		const { deps, applyTitle } = makeDeps({ threadTitlesEnabled: true }, { hasTitle: false, generated: false })
		applyTitle.mockResolvedValue(false)
		await maybeGenerateThreadTitle(deps, "t1", "first message")
		expect(applyTitle).toHaveBeenCalledTimes(1)
	})

	it("ignores empty first messages and empty model output", async () => {
		const { deps, applyTitle } = makeDeps({ threadTitlesEnabled: true }, { hasTitle: false, generated: false })
		await maybeGenerateThreadTitle(deps, "t1", "   ")
		expect(mocks.buildApiHandler).not.toHaveBeenCalled()
		mocks.createMessage.mockReturnValue(streamOf(""))
		await maybeGenerateThreadTitle(deps, "t1", "real message")
		expect(applyTitle).not.toHaveBeenCalled()
	})
})

describe("sanitizeThreadTitle", () => {
	it("takes the first line, strips formatting and caps at 8 words", () => {
		expect(sanitizeThreadTitle('"Fix the flaky login redirect test in auth today now."\nignored')).toBe(
			"Fix the flaky login redirect test in auth",
		)
		expect(sanitizeThreadTitle("**Short title**")).toBe("Short title")
		expect(sanitizeThreadTitle("  \n")).toBe("")
	})
})
