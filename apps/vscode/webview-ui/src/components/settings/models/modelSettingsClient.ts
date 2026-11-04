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

/** Every ModelsService settings call carries one JSON string each way. Encoded and decoded exactly once, here. */
const call = async <T>(method: (request: ModelSettingsRequestV1) => Promise<{ json: string }>, payload: unknown) => {
	const response = await method.call(ModelsServiceClient, ModelSettingsRequestV1.create({ json: JSON.stringify(payload) }))
	return JSON.parse(response.json) as T
}

const client = ModelsServiceClient

export const modelSettingsClient = {
	get: () => call<ModelSettingsState>(client.getModelSettings, {}),
	saveConnection: (expectedRevision: number, connection: ConnectionPatch | Connection, secrets: SecretMutation[] = []) =>
		call<ModelSettingsState>(client.saveConnection, { expectedRevision, connection, secrets }),
	saveModels: (expectedRevision: number, models: ModelRow[]) =>
		call<ModelSettingsState>(client.saveConfiguredModels, { expectedRevision, models }),
	duplicateModel: (modelId: string) => call<{ draft: ModelRow }>(client.duplicateConfiguredModel, { modelId }),
	deleteModel: (expectedRevision: number, modelId: string) =>
		call<DeleteResult>(client.deleteConfiguredModel, { expectedRevision, modelId }),
	deleteConnection: (expectedRevision: number, connectionId: string) =>
		call<DeleteResult>(client.deleteConnection, { expectedRevision, connectionId }),
	setRoles: (expectedRevision: number, roles: RoleSettings) =>
		call<ModelSettingsState>(client.setModelRoles, { expectedRevision, roles }),
	setPolicy: (expectedRevision: number, subagents: SubagentPolicy) =>
		call<ModelSettingsState>(client.setSubagentPolicy, { expectedRevision, subagents }),
	discover: (expectedRevision: number, connectionId: string) =>
		call<DiscoveryResult>(client.discoverConnectionModels, { expectedRevision, connectionId }),
	testConnection: (expectedRevision: number, connectionId: string) =>
		call<DiscoveryResult>(client.testConnection, { expectedRevision, connectionId }),
	detect: (expectedRevision: number, pick: ModelPick) =>
		call<DetectResult>(client.detectConfiguredModel, { expectedRevision, pick }),
	testModel: (expectedRevision: number, pick: ModelPick) =>
		call<{ status: "ok" | "inference-failed" }>(client.testConfiguredModel, { expectedRevision, pick }),
	preview: (expectedRevision: number, pick: ModelPick) =>
		call<PreviewResult>(client.previewConfiguredModelRequest, { expectedRevision, pick }),
}
