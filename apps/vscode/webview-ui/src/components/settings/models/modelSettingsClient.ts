import type {
	Connection,
	ConnectionPatch,
	ModelPick,
	ModelRow,
	ModelValues,
	RoleSettings,
	SubagentPolicy,
} from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { ModelSettingsRequestV1 } from "@shared/proto/cline/models"
import { ModelsServiceClient } from "@/services/grpc-client"

export type SecretMutation = { field: string; operation: "keep" | "delete" } | { field: string; operation: "set"; value: string }

export interface DiscoveredModel {
	upstreamId: string
	name: string
	classification: "chat" | "unknown" | "non-chat"
	source: "catalog" | "discovered"
}

export interface DiscoveryResult {
	status: "ok" | "catalog" | "auth" | "network" | "no-list"
	models: DiscoveredModel[]
	manualEntry?: boolean
}

export interface DetectResult {
	modelId: string
	source: string
	status?: "no-list"
	manualEntry?: boolean
	metadata: Partial<ModelValues>
	fetchedAt: number
}

export type PreviewResult =
	| { exact: true; request: { url: string; method: string; headers: Record<string, string>; body: unknown } }
	| { exact: false; reason: string }

/** A mutation either wrote and returned the store, or a delete was refused for these reasons. */
export type DeleteResult = ModelSettingsState | { dependencies: string[] }

type SettingsRpc = {
	[K in keyof typeof ModelsServiceClient]: (typeof ModelsServiceClient)[K] extends (
		request: ModelSettingsRequestV1,
	) => Promise<{ json: string }>
		? K
		: never
}[keyof typeof ModelsServiceClient]

/** Every ModelsService settings call carries one JSON string each way. Encoded and decoded exactly once, here. */
const call = async <T>(method: SettingsRpc, payload: unknown) => {
	const send = ModelsServiceClient[method] as (request: ModelSettingsRequestV1) => Promise<{ json: string }>
	const response = await send.call(ModelsServiceClient, ModelSettingsRequestV1.create({ json: JSON.stringify(payload) }))
	return JSON.parse(response.json) as T
}

export const modelSettingsClient = {
	get: () => call<ModelSettingsState>("getModelSettings", {}),
	saveConnection: (expectedRevision: number, connection: ConnectionPatch | Connection, secrets: SecretMutation[] = []) =>
		call<ModelSettingsState>("saveConnection", { expectedRevision, connection, secrets }),
	saveModels: (expectedRevision: number, models: ModelRow[]) =>
		call<ModelSettingsState>("saveConfiguredModels", { expectedRevision, models }),
	duplicateModel: (modelId: string) => call<{ draft: ModelRow }>("duplicateConfiguredModel", { modelId }),
	deleteModel: (expectedRevision: number, modelId: string) =>
		call<DeleteResult>("deleteConfiguredModel", { expectedRevision, modelId }),
	deleteConnection: (expectedRevision: number, connectionId: string) =>
		call<DeleteResult>("deleteConnection", { expectedRevision, connectionId }),
	setRoles: (expectedRevision: number, roles: RoleSettings) =>
		call<ModelSettingsState>("setModelRoles", { expectedRevision, roles }),
	makeDefault: (expectedRevision: number, mode: "plan" | "act", pick: ModelPick) =>
		call<ModelSettingsState>("makeModelDefault", { expectedRevision, mode, pick }),
	setThreadModel: (input: { taskId: string; mode: "plan" | "act"; pick: ModelPick; nextMessageOnly: boolean }) =>
		call<{ applied: true }>("setThreadModelSelection", input),
	setPolicy: (expectedRevision: number, subagents: SubagentPolicy) =>
		call<ModelSettingsState>("setSubagentPolicy", { expectedRevision, subagents }),
	discover: (expectedRevision: number, connectionId: string) =>
		call<DiscoveryResult>("discoverConnectionModels", { expectedRevision, connectionId }),
	testConnection: (expectedRevision: number, connectionId: string) =>
		call<DiscoveryResult>("testConnection", { expectedRevision, connectionId }),
	detect: (expectedRevision: number, pick: ModelPick) =>
		call<DetectResult>("detectConfiguredModel", { expectedRevision, pick }),
	testModel: (expectedRevision: number, pick: ModelPick) =>
		call<{ status: "ok" | "inference-failed" }>("testConfiguredModel", { expectedRevision, pick }),
	savedThreadUsage: (modelIds: string[]) => call<{ savedThreads: number }>("getModelSavedThreadUsage", { modelIds }),
	preview: (expectedRevision: number, pick: ModelPick) =>
		call<PreviewResult>("previewConfiguredModelRequest", { expectedRevision, pick }),
}
