import type { Connection, ModelPick, ProviderConnection } from "@shared/model-settings"
import type { Mode } from "@shared/storage/types"
import { modelSettingsClient as client } from "./modelSettingsClient"
import { newId, newModelRow } from "./modelsView"

const accountConnection = (providerId: string, name: string): ProviderConnection => ({
	id: newId(),
	name,
	kind: "provider",
	providerId,
	baseUrl: null,
	auth: { kind: "sdk-account", providerId },
	headers: [],
	requestTimeoutMs: null,
	defaults: {},
	options: {},
	secretRefs: {},
})

const findProviderConnection = (connections: Connection[], providerId: string) =>
	connections.find((connection) => connection.kind === "provider" && connection.providerId === providerId)

/** The connection for an account the person signs in to, made if there isn't one yet. Picks nothing. */
export async function ensureAccountConnection(providerId: string, name: string): Promise<string> {
	const state = await client.get()
	const existing = findProviderConnection(state.settings.connections, providerId)
	if (existing) return existing.id
	const connection = accountConnection(providerId, name)
	await client.saveConnection(state.settings.revision, connection)
	return connection.id
}

/**
 * The person chose to run on this provider's model, from a button that says so. The model is added if it
 * isn't there, becomes the default for these modes and this chat's pick. Background text follows if it has
 * nothing, or was on the model being left. One it was pointed at on purpose stays.
 */
export async function moveToAccountModel(input: {
	providerId: string
	providerName: string
	upstreamId: string
	modes: Mode[]
	taskId: string
	leaving?: string
}): Promise<ModelPick> {
	let state = await client.get()
	let connection = findProviderConnection(state.settings.connections, input.providerId)
	if (!connection) {
		connection = accountConnection(input.providerId, input.providerName)
		state = await client.saveConnection(state.settings.revision, connection)
	}
	let row = state.settings.models.find((model) => model.connectionId === connection.id && model.upstreamId === input.upstreamId)
	if (!row) {
		row = newModelRow(connection.id, input.upstreamId, "", "chat")
		state = await client.saveModels(state.settings.revision, [row])
	}
	const pick = { modelId: row.id, levelId: "default" }
	for (const mode of input.modes) {
		state = await client.makeDefault(state.settings.revision, mode, pick)
	}
	const { roles } = state.settings
	if (!roles.background.pick || roles.background.pick.modelId === input.leaving) {
		await client.setRoles(state.settings.revision, { ...roles, background: { ...roles.background, pick } })
	}
	for (const mode of input.modes) {
		await client.setThreadModel({ taskId: input.taskId, mode, pick, nextMessageOnly: false })
	}
	return pick
}
