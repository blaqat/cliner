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

describe("maybeGenerateThreadTitle with the thread's captured configuration", () => {
	const profiles = [
		{ id: "ask-a", name: "Ask A", provider: "anthropic", modelId: "ask-model" },
		{ id: "act-a", name: "Act A", provider: "anthropic", modelId: "act-model" },
		{ id: "composer", name: "Composer pick", provider: "openai-native", modelId: "composer-model" },
		{ id: "titles", name: "Titles", provider: "anthropic", modelId: "titles-model" },
	]

	function makeThreadStore(settings: Record<string, unknown>) {
		const state: Record<string, unknown> = {
			apiConfigProfiles: profiles,
			askProfileId: "ask-a",
			actProfileId: "act-a",
			...settings,
		}
		return {
			getGlobalStateKey: (key: string) => state[key],
			getApiConfiguration: () => ({
				planModeApiProvider: "anthropic",
				planModeApiModelId: "ask-model",
				actModeApiProvider: "anthropic",
				actModeApiModelId: "act-model",
			}),
			getSecretForKey: vi.fn(() => undefined),
			listSecretStorageKeys: vi.fn(() => []),
		}
	}

	function run(settings: Record<string, unknown>, thread: Parameters<typeof maybeGenerateThreadTitle>[3]) {
		const deps: ThreadTitleDeps = {
			store: makeThreadStore({ threadTitlesEnabled: true, ...settings }) as never,
			getTitleState: vi.fn(async () => ({ hasTitle: false, generated: false })),
			applyTitle: vi.fn(async () => true),
		}
		return maybeGenerateThreadTitle(deps, "t1", "name this", thread).then(() => mocks.buildApiHandler.mock.calls[0])
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.buildApiHandler.mockReturnValue({ createMessage: mocks.createMessage })
		mocks.createMessage.mockReturnValue(streamOf("A title"))
	})

	it("uses the thread's pinned profile and mode, including a composer override", async () => {
		const [configuration, mode] = await run(
			{},
			{ mode: "act", selection: { askProfileId: "ask-a", actProfileId: "composer" } },
		)
		expect(mode).toBe("act")
		expect(configuration).toMatchObject({ actModeApiProvider: "openai-native" })
		expect(Object.values(configuration)).toContain("composer-model")
	})

	it("uses the thread's mode, not Act, when the thread started in Ask", async () => {
		const [configuration, mode] = await run(
			{},
			{ mode: "plan", selection: { askProfileId: "composer", actProfileId: "act-a" } },
		)
		expect(mode).toBe("plan")
		expect(configuration).toMatchObject({ planModeApiProvider: "openai-native" })
		expect(Object.values(configuration)).toContain("composer-model")
	})

	it("an explicit title profile still wins over the thread's configuration", async () => {
		const [configuration, mode] = await run(
			{ threadTitlesProfileId: "titles" },
			{ mode: "plan", selection: { askProfileId: "composer" } },
		)
		expect(mode).toBe("act")
		expect(configuration).toMatchObject({ actModeApiProvider: "anthropic", actModeApiModelId: "titles-model" })
	})

	it("is unaffected by later changes to the global selection", async () => {
		// Global Act now points elsewhere; the thread pinned its own profile.
		const [configuration] = await run({ actProfileId: "composer" }, { mode: "act", selection: { actProfileId: "act-a" } })
		expect(configuration).toMatchObject({ actModeApiProvider: "anthropic", actModeApiModelId: "act-model" })
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
