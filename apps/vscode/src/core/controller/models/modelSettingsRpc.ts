import { randomUUID } from "node:crypto"
import {
	ConnectionSchema,
	ModelPickSchema,
	ModelRowSchema,
	ModelSettingsSchema,
	RoleSettingsSchema,
	SubagentPolicySchema,
} from "@shared/model-settings"
import { z } from "zod"
import {
	assertModelSettingsUnlocked,
	connectionSecretRefs,
	modelDependencies,
	readModelSettingsState,
	validateConnectionSecretRefs,
} from "@/sdk/model-settings/host-settings"
import type { Controller } from ".."

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
		.object({ expectedRevision: revision, connection: ConnectionSchema, secrets: z.array(secretMutation).default([]) })
		.strict(),
	saveConfiguredModels: z.object({ expectedRevision: revision, models: z.array(ModelRowSchema) }).strict(),
	duplicateConfiguredModel: z.object({ modelId: z.string().min(1) }).strict(),
	deleteConfiguredModel: z.object({ expectedRevision: revision, modelId: z.string().min(1) }).strict(),
	deleteConnection: z.object({ expectedRevision: revision, connectionId: z.string().min(1) }).strict(),
	setModelRoles: z.object({ expectedRevision: revision, roles: RoleSettingsSchema }).strict(),
	setSubagentPolicy: z.object({ expectedRevision: revision, subagents: SubagentPolicySchema }).strict(),
	makeModelDefault: z.object({ expectedRevision: revision, mode: z.enum(["plan", "act"]), pick: ModelPickSchema }).strict(),
}
export type SettingsMutation = keyof typeof schemas

export async function mutateSettings(controller: Controller, operation: SettingsMutation, payload: string): Promise<unknown> {
	const parsed = schemas[operation].parse(JSON.parse(payload))
	if (operation === "duplicateConfiguredModel") {
		const input = schemas.duplicateConfiguredModel.parse(parsed)
		const row = controller.stateManager.getGlobalStateKey("modelSettings")?.models.find((m) => m.id === input.modelId)
		if (!row) throw new Error("Configured model is missing")
		const draft = { ...structuredClone(row), id: randomUUID(), upstreamId: "", name: "" }
		delete draft.legacyMetadata
		return { draft }
	}
	const expectedRevision = (parsed as { expectedRevision: number }).expectedRevision
	let dependencies: string[] = []
	await controller.stateManager.mutateModelSettings(expectedRevision, async (settings) => {
		const next = structuredClone(settings)
		let rollback: (() => Promise<void>) | undefined
		switch (operation) {
			case "saveConnection": {
				const input = schemas.saveConnection.parse(parsed)
				validateConnectionSecretRefs(input.connection)
				const index = next.connections.findIndex((c) => c.id === input.connection.id)
				if (index < 0) next.connections.push(input.connection)
				else next.connections[index] = input.connection
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
					const saved = historical ? { ...row, legacyMetadata: historical } : row
					if (index < 0) next.models.push(saved)
					else next.models[index] = saved
				}
				break
			}
			case "deleteConfiguredModel": {
				const { modelId } = schemas.deleteConfiguredModel.parse(parsed)
				dependencies = modelDependencies(controller.stateManager, next, [modelId])
				if (dependencies.length) throw new DependencyError(dependencies)
				next.models = next.models.filter((m) => m.id !== modelId)
				break
			}
			case "deleteConnection": {
				const { connectionId } = schemas.deleteConnection.parse(parsed)
				const rows = next.models.filter((m) => m.connectionId === connectionId)
				dependencies = [
					...rows.map((m) => `model:${m.id}`),
					...modelDependencies(
						controller.stateManager,
						next,
						rows.map((m) => m.id),
					),
				]
				if (dependencies.length) throw new DependencyError(dependencies)
				next.connections = next.connections.filter((c) => c.id !== connectionId)
				break
			}
			case "setModelRoles":
				next.roles = schemas.setModelRoles.parse(parsed).roles
				break
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
			const refs = new Set(connectionSecretRefs(input.connection))
			const touched = new Set<string>()
			for (const mutation of input.secrets) {
				const ref = `settings:v1:connection:${input.connection.id}:${mutation.field}`
				if (!refs.has(ref) || touched.has(ref)) throw new Error("Invalid or duplicate secret field")
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
	await controller.postStateToWebview(true)
	return readModelSettingsState(controller.stateManager)
}

export class DependencyError extends Error {
	constructor(readonly dependencies: string[]) {
		super("This item is still in use")
	}
}
