import { describe, expect, it } from "bun:test"
import type { ApiConfiguration } from "@shared/api"
import { readTaskApiSelection, type TaskApiSelection, taskApiSelectionsEqual } from "@shared/api-profiles"
import {
	type ApiProfileStore,
	applyTaskApiSelection,
	captureTaskApiSelection,
	resolveApiConfigurationForTaskSelection,
	resolveTaskApiSelection,
	upsertApiConfigProfile,
} from "../apiProfiles"

function createStore(config: Partial<ApiConfiguration> = {}) {
	const globalState: Record<string, unknown> = {}
	const secretsStore: Record<string, string> = {}
	const apiConfig: Record<string, unknown> = { ...config }

	const store: ApiProfileStore = {
		getGlobalStateKey: ((key: string) => globalState[key]) as ApiProfileStore["getGlobalStateKey"],
		setGlobalStateBatch: (updates) => {
			Object.assign(globalState, updates)
			Object.assign(apiConfig, updates)
		},
		getApiConfiguration: () => apiConfig as ApiConfiguration,
		setApiConfiguration: (updates) => {
			for (const [key, value] of Object.entries(updates)) {
				if (value !== undefined) {
					apiConfig[key] = value
				}
			}
		},
		getSecretForKey: (key) => secretsStore[key],
		setSecretsForKeys: (entries) => {
			for (const [key, value] of Object.entries(entries)) {
				if (value === undefined || value === "") {
					delete secretsStore[key]
				} else {
					secretsStore[key] = value
				}
			}
		},
		listSecretStorageKeys: () => Object.keys(secretsStore),
	}
	return { store, globalState, secretsStore, apiConfig }
}

describe("readTaskApiSelection", () => {
	it("returns undefined for non-object metadata", () => {
		expect(readTaskApiSelection(undefined)).toBeUndefined()
		expect(readTaskApiSelection("plan")).toBeUndefined()
		expect(readTaskApiSelection(42)).toBeUndefined()
	})

	it("parses stored fields and drops invalid ones", () => {
		expect(
			readTaskApiSelection({
				askProfileId: "ask-1",
				actProfileId: "act-1",
				planModeReasoningEffort: "high",
				actModeReasoningEffort: "bogus",
				extra: "ignored",
			}),
		).toEqual({ askProfileId: "ask-1", actProfileId: "act-1", planModeReasoningEffort: "high" })
	})

	it("returns undefined when nothing usable is stored", () => {
		expect(readTaskApiSelection({})).toBeUndefined()
		expect(readTaskApiSelection({ askProfileId: "  " })).toBeUndefined()
	})
})

describe("taskApiSelectionsEqual", () => {
	it("treats undefined as equal only to undefined", () => {
		expect(taskApiSelectionsEqual(undefined, undefined)).toBe(true)
		expect(taskApiSelectionsEqual({ askProfileId: "a" }, undefined)).toBe(false)
		expect(taskApiSelectionsEqual({ askProfileId: "a" }, { askProfileId: "a" })).toBe(true)
		expect(taskApiSelectionsEqual({ askProfileId: "a" }, { askProfileId: "b" })).toBe(false)
	})
})

describe("captureTaskApiSelection", () => {
	it("reads both mode assignments and reasoning efforts", () => {
		const { store, globalState } = createStore({
			planModeReasoningEffort: "low",
			actModeReasoningEffort: "high",
		})
		globalState.askProfileId = "ask-1"
		globalState.actProfileId = "act-1"

		expect(captureTaskApiSelection(store)).toEqual({
			askProfileId: "ask-1",
			actProfileId: "act-1",
			planModeReasoningEffort: "low",
			actModeReasoningEffort: "high",
		})
	})
})

describe("resolveTaskApiSelection", () => {
	it("keeps stored ids and drops ones that no longer exist", () => {
		const { store } = createStore()
		const kept = upsertApiConfigProfile(store, { name: "Kept", provider: "anthropic", modelId: "claude" })
		const resolved = resolveTaskApiSelection(
			store,
			{ apiSelection: { askProfileId: kept.id, actProfileId: "deleted-id" } },
			"act",
		)
		expect(resolved.askProfileId).toBe(kept.id)
		expect(resolved.actProfileId).toBeUndefined()
	})

	it("falls back to matching the recorded provider+model for the task's mode", () => {
		const { store } = createStore()
		const profile = upsertApiConfigProfile(store, { name: "P", provider: "openai", modelId: "gpt-5.5" })
		const resolved = resolveTaskApiSelection(store, { apiProvider: "openai", modelId: "gpt-5.5" }, "act")
		expect(resolved.actProfileId).toBe(profile.id)
		expect(resolved.askProfileId).toBeUndefined()
	})

	it("leaves the selection unset when nothing matches", () => {
		const { store } = createStore()
		upsertApiConfigProfile(store, { name: "P", provider: "openai", modelId: "gpt-5.5" })
		const resolved = resolveTaskApiSelection(store, { apiProvider: "anthropic", modelId: "claude" }, "act")
		expect(resolved.actProfileId).toBeUndefined()
	})
})

describe("applyTaskApiSelection", () => {
	it("assigns profiles and efforts per mode without touching defaults", () => {
		const { store, globalState, apiConfig } = createStore()
		const ask = upsertApiConfigProfile(store, { name: "Ask", provider: "anthropic", modelId: "claude-a" })
		const act = upsertApiConfigProfile(store, { name: "Act", provider: "openai", modelId: "gpt-5.5" })

		const applied = applyTaskApiSelection(store, {
			askProfileId: ask.id,
			actProfileId: act.id,
			planModeReasoningEffort: "low",
			actModeReasoningEffort: "xhigh",
		})

		expect(applied).toBe(true)
		expect(globalState.askProfileId).toBe(ask.id)
		expect(globalState.actProfileId).toBe(act.id)
		expect(apiConfig.planModeApiProvider).toBe("anthropic")
		expect(apiConfig.actModeApiProvider).toBe("openai")
		expect(apiConfig.planModeReasoningEffort).toBe("low")
		expect(apiConfig.actModeReasoningEffort).toBe("xhigh")
	})

	it("restricts to a single mode when given and skips unknown ids", () => {
		const { store, globalState } = createStore()
		const act = upsertApiConfigProfile(store, { name: "Act", provider: "openai", modelId: "gpt-5.5" })
		globalState.askProfileId = "existing-ask"

		applyTaskApiSelection(store, { askProfileId: "missing", actProfileId: act.id }, "act")

		expect(globalState.askProfileId).toBe("existing-ask")
		expect(globalState.actProfileId).toBe(act.id)
	})
})

describe("resolveApiConfigurationForTaskSelection", () => {
	it("overlays the pinned profile and effort over the resolved snapshot", () => {
		const { store, apiConfig } = createStore({
			actModeApiProvider: "anthropic",
			actModeReasoningEffort: "low",
		})
		const pinned = upsertApiConfigProfile(store, {
			name: "Pinned",
			provider: "openai",
			modelId: "gpt-5.5",
			options: { openAiBaseUrl: "https://pinned/v1" },
			secrets: { openAiApiKey: "pinned-key" },
		})

		const resolved = resolveApiConfigurationForTaskSelection(store, apiConfig as ApiConfiguration, "act", {
			actProfileId: pinned.id,
			actModeReasoningEffort: "high",
		})

		expect(resolved.actModeApiProvider).toBe("openai")
		expect(resolved.actModeOpenAiModelId).toBe("gpt-5.5")
		expect(resolved.openAiBaseUrl).toBe("https://pinned/v1")
		expect(resolved.openAiApiKey).toBe("pinned-key")
		expect(resolved.actModeReasoningEffort).toBe("high")
	})

	it("falls back to the snapshot when the pinned profile was deleted", () => {
		const { store, apiConfig } = createStore({ actModeApiProvider: "anthropic" })
		const resolved = resolveApiConfigurationForTaskSelection(store, apiConfig as ApiConfiguration, "act", {
			actProfileId: "gone",
		})
		expect(resolved.actModeApiProvider).toBe("anthropic")
	})
})

describe("TaskApiSelection metadata shape", () => {
	it("round-trips through a plain object", () => {
		const selection: TaskApiSelection = {
			askProfileId: "a",
			actProfileId: "b",
			planModeReasoningEffort: "medium",
			actModeReasoningEffort: "none",
		}
		expect(readTaskApiSelection(JSON.parse(JSON.stringify({ apiSelection: selection })).apiSelection)).toEqual(selection)
	})
})
