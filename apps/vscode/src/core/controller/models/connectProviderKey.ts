import { randomUUID } from "node:crypto"
import { createGateway, getProviderCollectionSync } from "@cline/llms"
import { createDefaultModelSettings, type ModelPick, type ProviderConnection } from "@shared/model-settings"
import type { Controller } from ".."
import { mutateSettings } from "./modelSettingsRpc"

const providerDefaultModel = (providerId: string) =>
	createGateway()
		.listProviders()
		.find((provider) => provider.id === providerId)?.defaultModelId ??
	getProviderCollectionSync(providerId)?.provider.defaultModelId

const providerName = (providerId: string) =>
	createGateway()
		.listProviders()
		.find((provider) => provider.id === providerId)?.name ?? providerId

/**
 * Signing in to a provider that hands back a key, in the new store. Saves the key on the provider's
 * connection and runs Chat and Background text on it, like the old sign-in switching both modes. A model
 * already running on that connection stays: signing in again only replaces the key.
 *
 * Returns false when the key is saved but nothing can be picked for it, so the caller can say so.
 */
export async function connectProviderKey(
	controller: Controller,
	providerId: string,
	apiKey: string,
	enabled?: boolean,
): Promise<{ connectionId: string; picked: boolean }> {
	const settings = () => controller.stateManager.getGlobalStateKey("modelSettings") ?? createDefaultModelSettings()
	const existing = settings().connections.find(
		(connection): connection is ProviderConnection => connection.kind === "provider" && connection.providerId === providerId,
	)
	const connectionId = existing?.id ?? randomUUID()
	const prefix = `settings:v1:connection:${connectionId}:`
	const secretRef = existing?.auth.kind === "keychain" ? existing.auth.secretRef : `${prefix}apiKey`
	const auth = { kind: "keychain" as const, secretRef }
	const connection: ProviderConnection | { id: string; auth: typeof auth } = existing
		? { id: connectionId, auth }
		: {
				id: connectionId,
				name: providerName(providerId),
				kind: "provider",
				providerId,
				baseUrl: null,
				auth,
				headers: [],
				requestTimeoutMs: null,
				defaults: {},
				options: {},
				secretRefs: {},
			}
	await mutateSettings(
		controller,
		"saveConnection",
		JSON.stringify({
			expectedRevision: settings().revision,
			connection,
			secrets: [{ field: secretRef.slice(prefix.length), operation: "set", value: apiKey }],
		}),
		enabled,
	)

	const onConnection = settings().models.filter((row) => row.connectionId === connectionId)
	const running = (pick: ModelPick | null) => onConnection.some((row) => row.id === pick?.modelId)
	if (running(settings().roles.chat)) return { connectionId, picked: true }

	let modelId = onConnection.find((row) => row.kind !== "non-chat")?.id
	if (!modelId) {
		const upstreamId = providerDefaultModel(providerId)
		if (!upstreamId) return { connectionId, picked: false }
		modelId = randomUUID()
		await mutateSettings(
			controller,
			"saveConfiguredModels",
			JSON.stringify({
				expectedRevision: settings().revision,
				models: [{ id: modelId, connectionId, upstreamId, name: "", kind: "chat", overrides: {}, providerOptions: {} }],
			}),
			enabled,
		)
	}
	const { roles } = settings()
	const pick = { modelId, levelId: "default" }
	await mutateSettings(
		controller,
		"setModelRoles",
		JSON.stringify({
			expectedRevision: settings().revision,
			roles: {
				...roles,
				chat: pick,
				ask: roles.ask.enabled ? { ...roles.ask, pick } : roles.ask,
				background: { ...roles.background, pick },
			},
		}),
		enabled,
	)
	return { connectionId, picked: true }
}
