import type { ModelSettingsState } from "@shared/model-settings-state"
import { describe, expect, it, vi } from "vitest"
import { modelSendBlock } from "./composerSelection"

vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: {} }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({}) }))

const pick = (modelId: string) => ({ modelId, levelId: "default" })

const state = (roles: { chat?: string; ask?: string } = {}, models = ["m"]) =>
	({
		settings: {
			connections: [{ id: "c" }],
			models: models.map((id) => ({ id, connectionId: "c", kind: id === "embed" ? "non-chat" : "chat" })),
			roles: {
				chat: roles.chat ? pick(roles.chat) : null,
				ask: { enabled: !!roles.ask, pick: roles.ask ? pick(roles.ask) : null },
			},
		},
	}) as unknown as ModelSettingsState

const thread = (act: string | null, ask: string | null) => ({
	modelSelectionV1: { act: act ? pick(act) : null, ask: ask ? pick(ask) : null },
})

describe("modelSendBlock", () => {
	it("never blocks before the store exists: the last selection still runs", () => {
		expect(modelSendBlock(undefined, undefined, "act")).toBeUndefined()
	})

	it("passes a pick that exists, including a turned-off model a thread is already on", () => {
		const off = state({}, ["m"])
		;(off.settings.models[0] as { enabled?: boolean }).enabled = false
		expect(modelSendBlock(off, thread("m", null), "act")).toBeUndefined()
	})

	it("a thread with no pick follows the default, for Act and Ask alike", () => {
		expect(modelSendBlock(state({ chat: "m" }), thread(null, null), "act")).toBeUndefined()
		expect(modelSendBlock(state({ chat: "m" }), thread(null, null), "plan")).toBeUndefined()
		expect(modelSendBlock(state({ ask: "m" }), thread(null, null), "plan")).toBeUndefined()
	})

	it("a pick whose model is gone blocks, even with a default set: the thread is asked, not moved", () => {
		expect(modelSendBlock(state({ chat: "m" }), thread("gone", null), "act")).toMatchObject({
			reason: "The model this chat used is gone.",
			setUp: false,
		})
	})

	it("judges each mode on its own pick", () => {
		const selection = thread("gone", "m")
		expect(modelSendBlock(state(), selection, "act")).toBeDefined()
		expect(modelSendBlock(state(), selection, "plan")).toBeUndefined()
	})

	it("nothing picked names the mode; nothing set up points at setting one up", () => {
		expect(modelSendBlock(state(), undefined, "plan")).toMatchObject({ reason: "No Ask model is picked.", setUp: false })
		expect(modelSendBlock(state({}, []), undefined, "act")).toMatchObject({ reason: "No models are set up.", setUp: true })
		expect(modelSendBlock(state({}, ["embed"]), undefined, "act")).toMatchObject({ setUp: true })
	})
})
