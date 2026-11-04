import { BASE_URL_NEEDED, MODEL_ID_NEEDED, type ModelSettings } from "@shared/model-settings"
import type { ModelSettingsMigrationIssue, ModelSettingsMigrationStatus } from "@shared/model-settings-migration-status"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { LinkButton } from "../models/fields"
import type { SettingsNavigationTarget } from "../settingsTargets"
import { useSettingsShell } from "../shell/SettingsShellContext"

/** The first move failed, so the old setup is still what runs. The cause is a fixed description, never a saved value. */
export const MigrationFailedNotice = ({
	status,
	onRetried,
}: {
	status: ModelSettingsMigrationStatus
	onRetried?: (status: ModelSettingsMigrationStatus) => void
}) => {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const retry = async () => {
		setBusy(true)
		setError("")
		try {
			const response = await ModelsServiceClient.retryModelSettingsMigration({ json: "{}" })
			onRetried?.(JSON.parse(response.json))
		} catch {
			setError("Migration could not finish. Your previous setup is preserved. Retry when ready.")
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className="rounded border border-warning p-2 text-[11px]" role="status">
			<p className="m-0">Models could not be moved. Your previous setup is preserved.</p>
			{status.cause && <p className="m-0 mt-1 text-description">{status.cause}</p>}
			{status.retryable && (
				<Button className="mt-1.5" disabled={busy} onClick={() => void retry()} size="sm" variant="secondary">
					{busy ? "Retrying…" : "Retry migration"}
				</Button>
			)}
			{error && (
				<p className="m-0 mt-1 text-error" role="alert">
					{error}
				</p>
			)}
		</div>
	)
}

const FIELD_WORDS: Record<string, string> = {
	contextWindow: "context window",
	maxOutputTokens: "max output tokens",
	maxInputTokens: "max input tokens",
	inputPrice: "input price",
	outputPrice: "output price",
	cacheReadPrice: "cache read price",
	cacheWritePrice: "cache write price",
	thinkingBudgetTokens: "thinking budget",
	systemRole: "system role",
	subagentsMaxConcurrent: "cap",
	subagentAllowedModelProfileIds: "allowed models",
	metadata: "model details",
}
const fieldWords = (field: string) => FIELD_WORDS[field] ?? field

export type MigrationIssueRow = { text: string; action: string; target: SettingsNavigationTarget }

/** What the issue left to do and where to do it. Undefined once it's fixed or its row is gone. */
export const migrationIssueRow = (
	issue: ModelSettingsMigrationIssue,
	settings: ModelSettings | undefined,
): MigrationIssueRow | undefined => {
	const model = settings?.models.find((row) => row.id === issue.modelId)
	const connection = settings?.connections.find((row) => row.id === (issue.connectionId ?? model?.connectionId))
	if (settings && ((issue.modelId && !model) || (issue.connectionId && !connection))) {
		return undefined
	}
	const { source, field } = issue
	if (field === "modelId") {
		return model?.upstreamId === MODEL_ID_NEEDED
			? {
					text: `${source}: no model ID was saved, so it can't run.`,
					action: "Add the model ID",
					target: `model:${model.id}:upstreamId`,
				}
			: undefined
	}
	if (field === "baseUrl") {
		return connection?.baseUrl === BASE_URL_NEEDED
			? {
					text: `${source}: the saved base URL wasn't valid, so it can't run.`,
					action: "Enter the base URL",
					target: `connection:${connection.id}`,
				}
			: undefined
	}
	if (field === "level" && model) {
		return {
			text: `${source}: the saved reasoning level isn't offered by this model, so it moved to the closest lower one.`,
			action: "Change it",
			target: `model:${model.id}:levels`,
		}
	}
	const isSubagents = source === "Subagents"
	const fix: SettingsNavigationTarget = isSubagents
		? "subagents"
		: issue.modelId && issue.kind === "normalized"
			? `model:${issue.modelId}:${field}`
			: issue.connectionId
				? `connection:${issue.connectionId}`
				: "models"
	if (issue.kind === "normalized") {
		return {
			text: `${source}: the saved ${fieldWords(field)} wasn't valid, so it wasn't kept.`,
			action: "Set it",
			target: fix,
		}
	}
	return issue.modelId || issue.connectionId || isSubagents
		? { text: `${source}: the saved ${fieldWords(field)} couldn't be kept.`, action: "Set it again", target: fix }
		: { text: `${source}: couldn't be moved.`, action: "Set it up again", target: fix }
}

/** Saved values the move changed or couldn't keep. Rows that can't run are flagged here and on Models. */
export const MigrationIssues = ({ issues }: { issues?: ModelSettingsMigrationIssue[] }) => {
	const { modelSettings } = useExtensionState()
	const { openRow } = useSettingsShell()
	const rows = (issues ?? []).flatMap((issue) => migrationIssueRow(issue, modelSettings?.settings) ?? [])
	if (!rows.length) {
		return null
	}
	return (
		<div className="mt-1.5 rounded border border-warning p-2 text-[11px]" data-testid="migration-issues">
			<p className="m-0 mb-1">Some saved values need a look:</p>
			<ul className="m-0 flex list-none flex-col gap-1 p-0">
				{rows.map((row) => (
					<li key={`${row.text}:${row.target}`}>
						{row.text} <LinkButton onClick={() => openRow(row.target)}>{row.action}</LinkButton>
					</li>
				))}
			</ul>
		</div>
	)
}
