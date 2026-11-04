import { randomUUID } from "node:crypto"
import {
	applyConnectionPatch,
	type Connection,
	ConnectionPatchSchema,
	ModelPickSchema,
	ModelRowSchema,
	type ModelSettings,
	ModelSettingsSchema,
	RoleSettingsSchema,
	SubagentPolicySchema,
} from "@shared/model-settings"
import { z } from "zod"
import {
	assertConnectionAllowed,
	assertModelSettingsUnlocked,
	connectionSecretRefs,
	followSharedDefaults,
	managedConnectionForSave,
	managedModelRow,
	modelDependencies,
	readModelSettingsState,
	savedThreadsUsingModels,
	validateConnectionSecretRefs,
	withSettledMigratedValues,
} from "@/sdk/model-settings/host-settings"
import { modelSettingsRolloutEnabled } from "@/sdk/model-settings/rollout"
import type { Controller } from ".."
import { cancelModelSettingsDiagnostics } from "./modelSettingsDiagnostics"

const revision = z.number().int().nonnegative()
const secretMutation = z.discriminatedUnion("operation", [
	z.object({ field: z.string().min(1), operation: z.literal("keep") }).strict(),
	z.object({ field: z.string().min(1), operation: z.literal("delete") }).strict(),
	z
		.object({
			field: z.string().min(1),
			operation: z.literal("set"),
			value: z
				.string()
				.min(1)
				.refine(
					(v) => !/^(?:[*•●]{2,}|<redacted>|\[redacted\]|masked$)/i.test(v.trim()),
					"Supply a new credential, not a masked placeholder",
				),
		})
		.strict(),
])
const schemas = {
	saveConnection: z
		.object({
			expectedRevision: revision,
			connection: ConnectionPatchSchema,
			secrets: z.array(secretMutation).default([]),
		})
		.strict(),
	saveConfiguredModels: z.object({ expectedRevision: revision, models: z.array(ModelRowSchema) }).strict(),
	duplicateConfiguredModel: z.object({ modelId: z.string().min(1) }).strict(),
	deleteConfiguredModel: z.object({ expectedRevision: revision, modelId: z.string().min(1) }).strict(),
	deleteConnection: z.object({ expectedRevision: revision, connectionId: z.string().min(1) }).strict(),
	setModelRoles: z
		.object({
			expectedRevision: revision,
			roles: RoleSettingsSchema,
			requestTimeoutMs: z.number().int().positive().nullable().optional(),
		})
		.strict(),
	setSubagentPolicy: z.object({ expectedRevision: revision, subagents: SubagentPolicySchema }).strict(),
	makeModelDefault: z.object({ expectedRevision: revision, mode: z.enum(["plan", "act"]), pick: ModelPickSchema }).strict(),
}
export type SettingsMutation = keyof typeof schemas

export async function mutateSettings(
	controller: Controller,
	operation: SettingsMutation,
	payload: string,
	enabled?: boolean,
): Promise<unknown> {
	if (!modelSettingsRolloutEnabled(enabled)) throw new Error("Model settings rollout is disabled")
	const parsed = schemas[operation].parse(JSON.parse(payload))
	if (operation === "duplicateConfiguredModel") {
		const stored = controller.stateManager.getGlobalStateKey("modelSettings")
		const input = schemas.duplicateConfiguredModel.parse(parsed)
		const row = stored?.models.find((m) => m.id === input.modelId)
		const source = stored?.connections.find((c) => c.id === row?.connectionId)
		if (!row || !source) throw new Error("Configured model is missing")
		assertConnectionAllowed(controller.stateManager, source)
		const draft = { ...structuredClone(row), id: randomUUID(), upstreamId: "", name: "" }
		delete draft.legacyMetadata
		return { draft }
	}
	const expectedRevision = (parsed as { expectedRevision: number }).expectedRevision
	await controller.stateManager.mutateModelSettings(expectedRevision, async (settings) => {
		const next = structuredClone(settings)
		let rollback: (() => Promise<void>) | undefined
		let previousConnection: Connection | undefined
		switch (operation) {
			case "saveConnection": {
				const input = schemas.saveConnection.parse(parsed)
				previousConnection = next.connections.find((c) => c.id === input.connection.id)
				const patched = applyConnectionPatch(previousConnection, input.connection)
				const connection = previousConnection ? patched : managedConnectionForSave(controller.stateManager, patched)
				validateConnectionSecretRefs(connection)
				const index = next.connections.findIndex((c) => c.id === input.connection.id)
				if (index < 0) next.connections.push(connection)
				else next.connections[index] = connection
				followSharedDefaults(next, connection, previousConnection)
				break
			}
			case "saveConfiguredModels": {
				const input = schemas.saveConfiguredModels.parse(parsed)
				if (new Set(input.models.map((m) => m.id)).size !== input.models.length) throw new Error("Duplicate model ID")
				for (const row of input.models) {
					const index = next.models.findIndex((m) => m.id === row.id)
					const historical = index < 0 ? undefined : next.models[index].legacyMetadata
					if (row.legacyMetadata !== undefined && JSON.stringify(row.legacyMetadata) !== JSON.stringify(historical))
						throw new Error("Historical model metadata is read-only")
					const saved = withSettledMigratedValues(
						historical ? { ...row, legacyMetadata: historical } : row,
						index < 0 ? undefined : next.models[index],
					)
					const owner = next.connections.find((c) => c.id === row.connectionId)
					if (index < 0) next.models.push(owner ? managedModelRow(controller.stateManager, saved, owner) : saved)
					else next.models[index] = saved
				}
				break
			}
			case "deleteConfiguredModel": {
				const { modelId } = schemas.deleteConfiguredModel.parse(parsed)
				const dependencies = blockingDependencies(controller.stateManager, next, [modelId])
				if (dependencies.length) throw new DependencyError(dependencies)
				next.models = next.models.filter((m) => m.id !== modelId)
				break
			}
			case "deleteConnection": {
				const { connectionId } = schemas.deleteConnection.parse(parsed)
				const rows = next.models.filter((m) => m.connectionId === connectionId)
				const dependencies = [
					...rows.map((m) => `model:${m.id}`),
					...blockingDependencies(
						controller.stateManager,
						next,
						rows.map((m) => m.id),
					),
				]
				if (dependencies.length) throw new DependencyError(dependencies)
				next.connections = next.connections.filter((c) => c.id !== connectionId)
				break
			}
			case "setModelRoles": {
				const input = schemas.setModelRoles.parse(parsed)
				next.roles = input.roles
				if (input.requestTimeoutMs !== undefined) next.requestTimeoutMs = input.requestTimeoutMs
				break
			}
			case "setSubagentPolicy":
				next.subagents = schemas.setSubagentPolicy.parse(parsed).subagents
				break
			case "makeModelDefault": {
				const { mode, pick } = schemas.makeModelDefault.parse(parsed)
				if (mode === "plan" && next.roles.ask.enabled) next.roles.ask.pick = pick
				else next.roles.chat = pick
				break
			}
		}
		ModelSettingsSchema.parse(next)
		assertModelSettingsUnlocked(controller.stateManager, next)
		if (operation === "saveConnection") {
			const input = schemas.saveConnection.parse(parsed)
			const store = controller.stateManager.connectionSecrets
			if (!store) throw new Error("Connection keychain is unavailable")
			const connection = next.connections.find((c) => c.id === input.connection.id)!
			const managed = controller.stateManager.getRemoteConfigSettings() as Record<string, unknown>
			for (const mutation of input.secrets) {
				if (mutation.operation === "keep") continue
				const ref = `settings:v1:connection:${connection.id}:${mutation.field}`
				if (
					managed[mutation.field] !== undefined ||
					(managed.openAiHeaders !== undefined &&
						connection.headers.some((h) => h.storage === "secret" && h.secretRef === ref))
				)
					throw new Error("Connection credential is managed by your organization")
			}
			// A delete can name a reference this same patch drops, so the two land together.
			const refs = new Set(connectionSecretRefs(connection))
			const dropped = new Set(previousConnection ? connectionSecretRefs(previousConnection) : [])
			const touched = new Set<string>()
			for (const mutation of input.secrets) {
				const ref = `settings:v1:connection:${input.connection.id}:${mutation.field}`
				const known = refs.has(ref) || (mutation.operation === "delete" && dropped.has(ref))
				if (!known || touched.has(ref)) throw new Error("Invalid or duplicate secret field")
				touched.add(ref)
			}
			// Validate the entire request before the first secret write.
			const previous = new Map<string, string | undefined>()
			rollback = async () => {
				for (const [ref, value] of previous) {
					if (value === undefined) await store.delete(ref)
					else await store.set(ref, value)
				}
			}
			try {
				for (const mutation of input.secrets) {
					if (mutation.operation === "keep") continue
					const ref = `settings:v1:connection:${input.connection.id}:${mutation.field}`
					previous.set(ref, await store.get(ref))
					if (mutation.operation === "set") await store.set(ref, mutation.value)
					else await store.delete(ref)
				}
			} catch (error) {
				for (const [ref, value] of previous) {
					if (value === undefined) await store.delete(ref)
					else await store.set(ref, value)
				}
				throw error
			}
		}
		if (operation === "deleteConnection") {
			const { connectionId } = schemas.deleteConnection.parse(parsed)
			const connection = settings.connections.find((c) => c.id === connectionId)
			const refs = connection ? connectionSecretRefs(connection) : []
			if (refs.length) {
				const store = controller.stateManager.connectionSecrets
				if (!store) throw new Error("Connection keychain is unavailable")
				const previous = new Map<string, string | undefined>()
				rollback = async () => {
					for (const [ref, value] of previous) if (value !== undefined) await store.set(ref, value)
				}
				try {
					for (const ref of refs) {
						previous.set(ref, await store.get(ref))
						await store.delete(ref)
					}
				} catch (error) {
					await rollback()
					throw error
				}
			}
		}

		Object.assign(settings, next)
		return rollback
	})
	cancelModelSettingsDiagnostics(controller.stateManager)
	// Idle sessions rebuild now, ahead of the next send; running ones when their turn ends.
	controller.handleApiConfigurationChanged?.({}, {})
	await controller.postStateToWebview(true)
	return readModelSettingsState(controller.stateManager)
}

/** Roles and the subagent policy have to be repointed first. A saved thread doesn't block: reopened, it asks for a pick. */
function blockingDependencies(state: Controller["stateManager"], settings: ModelSettings, ids: string[]): string[] {
	return modelDependencies(state, settings, ids).filter((path) => !path.startsWith("thread:"))
}

/** What deleting these models would touch without stopping it, so the confirmation can say so. */
export async function savedThreadUsage(controller: Controller, payload: string, enabled?: boolean) {
	if (!modelSettingsRolloutEnabled(enabled)) throw new Error("Model settings rollout is disabled")
	const { modelIds } = z
		.object({ modelIds: z.array(z.string().min(1)) })
		.strict()
		.parse(JSON.parse(payload))
	const history = await controller.getModelSelectionDependencies()
	return { savedThreads: savedThreadsUsingModels(controller.stateManager, modelIds, history).length }
}

export class DependencyError extends Error {
	constructor(readonly dependencies: string[]) {
		super("This item is still in use")
	}
}
