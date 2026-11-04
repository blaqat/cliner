import { createCompatibleConnection, createDefaultModelSettings, type ModelSettings } from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { DependencyError, mutateSettings } from "@/core/controller/models/modelSettingsRpc"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import { readModelSettingsState } from "./host-settings"

vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

function fixture() {
	let settings = createDefaultModelSettings()
	const connectionSecrets = new InMemoryConnectionSecretStore()
	const postStateToWebview = vi.fn()
	const state = {
		connectionSecrets,
		getGlobalStateKey: (key: string) => (key === "modelSettings" ? settings : []),
		getRemoteConfigSettings: () => ({}),
		getModelSettingsMigrationStatus: () => ({ status: "disabled", retryable: false }),
		mutateModelSettings: async (revision: number, mutate: (value: ModelSettings) => Promise<void>) => {
			if (revision !== settings.revision) throw new Error("revision")
			const next = structuredClone(settings)
			await mutate(next)
			next.revision++
			settings = next
		},
	}
	const controller = { stateManager: state, postStateToWebview }
	const call = (operation: Parameters<typeof mutateSettings>[1], input: unknown) =>
		mutateSettings(controller as never, operation, JSON.stringify(input))
	return { state, controller, call, get: () => settings, connectionSecrets, postStateToWebview }
}

describe("new settings host mutations", () => {
	it("reads defaults without writing and returns no secret values", async () => {
		const f = fixture()
		expect((await readModelSettingsState(f.state as never)).settings.revision).toBe(0)
		expect(f.get().connections).toEqual([])
	})
	it("saves write-only secrets and rejects placeholders before changing a credential", async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		const result = await f.call("saveConnection", {
			expectedRevision: 0,
			connection,
			secrets: [{ field: "apiKey", operation: "set", value: "real-test-secret" }],
		})
		expect(JSON.stringify(result)).not.toContain("real-test-secret")
		expect(await f.connectionSecrets.get(connection.auth.kind === "keychain" ? connection.auth.secretRef : "")).toBe(
			"real-test-secret",
		)
		await expect(
			f.call("saveConnection", {
				expectedRevision: 1,
				connection,
				secrets: [{ field: "apiKey", operation: "set", value: "••••••" }],
			}),
		).rejects.toThrow()
		expect(f.get().revision).toBe(1)
		expect(f.postStateToWebview).toHaveBeenCalledWith(true)
	})
	it("rejects foreign secret refs and fields before writing", async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		await expect(
			f.call("saveConnection", {
				expectedRevision: 0,
				connection: { ...connection, auth: { kind: "keychain", secretRef: "settings:v1:connection:other:apiKey" } },
				secrets: [],
			}),
		).rejects.toThrow(/secret reference/i)
		await expect(
			f.call("saveConnection", {
				expectedRevision: 0,
				connection,
				secrets: [{ field: "other", operation: "set", value: "secret" }],
			}),
		).rejects.toThrow("secret field")
		expect(f.get().revision).toBe(0)
	})
	it("preserves keep, deletes only on explicit delete, and checks revisions", async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		await f.connectionSecrets.set("settings:v1:connection:c:apiKey", "test-key")
		await f.call("saveConnection", { expectedRevision: 0, connection, secrets: [{ field: "apiKey", operation: "keep" }] })
		expect(await f.connectionSecrets.get("settings:v1:connection:c:apiKey")).toBe("test-key")
		await expect(f.call("saveConnection", { expectedRevision: 0, connection })).rejects.toThrow("revision")
		await f.call("saveConnection", { expectedRevision: 1, connection, secrets: [{ field: "apiKey", operation: "delete" }] })
		expect(await f.connectionSecrets.get("settings:v1:connection:c:apiKey")).toBeUndefined()
	})
	it("adds rows atomically without assigning roles; duplicates remain drafts", async () => {
		const f = fixture()
		await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
		const row = {
			id: "m",
			connectionId: "c",
			upstreamId: "upstream",
			name: "Name",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		}
		await expect(
			f.call("saveConfiguredModels", {
				expectedRevision: 1,
				models: [row, { ...row, id: "bad", connectionId: "missing" }],
			}),
		).rejects.toThrow()
		expect(f.get().models).toEqual([])
		await f.call("saveConfiguredModels", { expectedRevision: 1, models: [row] })
		expect(f.get().roles.chat).toBeNull()
		const copy = (await f.call("duplicateConfiguredModel", { modelId: "m" })) as { draft: typeof row }
		expect(copy.draft).toMatchObject({ upstreamId: "", name: "", connectionId: "c" })
		expect(copy.draft.id).not.toBe("m")
		expect(f.get().models).toHaveLength(1)
	})
	it("routes Make default for Ask and reports dependencies instead of silently replacing picks", async () => {
		const f = fixture()
		await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
		await f.call("saveConfiguredModels", {
			expectedRevision: 1,
			models: [
				{ id: "m", connectionId: "c", upstreamId: "model", name: "", kind: "chat", overrides: {}, providerOptions: {} },
			],
		})
		const pick = { modelId: "m", levelId: "default" }
		await f.call("makeModelDefault", { expectedRevision: 2, mode: "plan", pick })
		expect(f.get().roles.chat).toEqual(pick)
		await expect(f.call("deleteConfiguredModel", { expectedRevision: 3, modelId: "m" })).rejects.toBeInstanceOf(
			DependencyError,
		)
		expect(f.get().models).toHaveLength(1)
		await expect(f.call("deleteConnection", { expectedRevision: 3, connectionId: "c" })).rejects.toBeInstanceOf(
			DependencyError,
		)
		const roles = { ...f.get().roles, chat: null, ask: { enabled: true, pick: null } }
		await f.call("setModelRoles", { expectedRevision: 3, roles })
		await f.call("makeModelDefault", { expectedRevision: 4, mode: "plan", pick })
		expect(f.get().roles.ask.pick).toEqual(pick)
		expect(f.get().roles.chat).toBeNull()
	})
})
