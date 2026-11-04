import { createDefaultModelSettings, type SubagentPolicy } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { ModelSettingsRequestV1 } from "@shared/proto/cline/models"
import type { UpdateSettingsRequest } from "@shared/proto/cline/state"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import type { SettingsPageId } from "../settingsTargets"
import { updateSetting } from "../utils/settingsHandlers"
import type { InfoRow, PreferenceRow, SettingsRow, SettingsRowContext } from "./settingsRegistry"

type RowFields<R extends SettingsRow> = Omit<R, "page" | "kind">
type StoredFields<T> = Omit<RowFields<PreferenceRow<T>>, "defaultValue" | "read" | "write">

const pageOf = (id: string) => id.split(".")[0] as SettingsPageId

export const preference = <T>(row: RowFields<PreferenceRow<T>>) =>
	({ ...row, page: pageOf(row.id), kind: "preference" }) as PreferenceRow as SettingsRow

/** A preference stored as one `UpdateSettingsRequest` field and published under the same name. */
export const stored = <T>(
	key: keyof UpdateSettingsRequest & keyof ExtensionStateContextType,
	fallback: T,
	row: StoredFields<T>,
) =>
	preference<T>({
		...row,
		defaultValue: () => fallback,
		read: (ctx) => (ctx.state[key] ?? fallback) as T,
		write: (value) => updateSetting(key, value),
	})

export const action = (row: RowFields<InfoRow>): SettingsRow => ({ ...row, page: pageOf(row.id), kind: "action" })
export const state = (row: RowFields<InfoRow>): SettingsRow => ({ ...row, page: pageOf(row.id), kind: "state" })

export const POLICY_DEFAULTS = createDefaultModelSettings().subagents

/** Revision-checked against the latest store, not the last published copy. */
export const updateSubagentPolicy = async (change: (policy: SubagentPolicy) => SubagentPolicy) => {
	const response = await ModelsServiceClient.getModelSettings(ModelSettingsRequestV1.create({ json: "{}" }))
	const latest = JSON.parse(response.json) as ModelSettingsState
	await ModelsServiceClient.setSubagentPolicy(
		ModelSettingsRequestV1.create({
			json: JSON.stringify({ expectedRevision: latest.settings.revision, subagents: change(latest.settings.subagents) }),
		}),
	)
}

export const policyOf = (ctx: SettingsRowContext) => ctx.state.modelSettings?.settings.subagents ?? POLICY_DEFAULTS
export const onlyWithSubagents = (ctx: SettingsRowContext) => (policyOf(ctx).enabled ? undefined : "Only with Subagents on.")

export const SUBAGENT_ACCESS = [
	["write", "Edit files", "Let subagents edit files in Act.", "subagentsAllowWrite", "write"],
	["commands", "Commands", "Let subagents run shell commands.", "subagentsAllowCommands", "shell terminal"],
	["web", "Web", "Let subagents use the web.", "subagentsAllowWeb", "internet search fetch"],
	["mcp", "MCP tools", "Let subagents use MCP tools.", "subagentsAllowMcp", "servers"],
] as const

const backgroundExec = (ctx: SettingsRowContext) => ctx.state.vscodeTerminalExecutionMode === "backgroundExec"
export const onlyWithVsCodeTerminal = (ctx: SettingsRowContext) =>
	backgroundExec(ctx) ? "Only with the VS Code terminal." : undefined
