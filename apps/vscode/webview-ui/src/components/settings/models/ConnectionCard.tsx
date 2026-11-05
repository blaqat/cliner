import type { Connection, ModelRow } from "@shared/model-settings"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { settingsConnectionElementId, settingsModelElementId } from "../settingsTargets"
import { AddModelsPanel } from "./AddModelsPanel"
import { ConnectionForm, RequestTimeoutField } from "./ConnectionForm"
import { ActionButton, Chevron, FieldGrid, GroupHeading, LockedIcon, SmallSwitch, Status, Why } from "./fields"
import { ModelForm } from "./ModelForm"
import { useModelsPage } from "./modelsPageContext"
import { connectionName, ENV_EMPTY, formatTokens, KEY_MISSING, levelRange, modelName, priceSummary } from "./modelsView"
import { signOutProvider } from "./ProviderChooser"
import { ProviderConnectionFields } from "./ProviderFields"
import { providerSpec } from "./providerSpecs"
import { RemoveFlow } from "./RemoveFlow"
import { SharedDefaults } from "./SharedDefaults"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const connectionLevel = (reason: string) => KEY_MISSING.test(reason) || ENV_EMPTY.test(reason)

/** Only what's wrong. Everything fine says nothing. */
const modelStatus = (row: ModelRow, available: { available: boolean; reason?: string } | undefined, enabled: boolean) => {
	if (!row.upstreamId) {
		return (
			<Status icon="warning" tone="warn">
				Needs an ID
			</Status>
		)
	}
	if (row.kind === "non-chat") {
		return <span className="whitespace-nowrap text-[12px] text-description">Not for chat</span>
	}
	if (!enabled) {
		return null
	}
	if (available && !available.available && !connectionLevel(available.reason ?? "")) {
		return (
			<Status icon="warning" title={available.reason ?? "This model can't run."} tone="bad">
				Can't run
			</Status>
		)
	}
	return null
}

const ModelRowView = ({ row, connection, isDraft }: { row: ModelRow; connection: Connection; isDraft: boolean }) => {
	const page = useModelsPage()
	const { store } = page
	const [error, setError] = useState<string>()
	const open = page.openModel === row.id
	const effective = store.state?.effective[row.id]
	const enabled = row.enabled !== false

	const setEnabled = async (on: boolean) => {
		setError(undefined)
		const outcome = await store.updateModel(row.id, ({ enabled: _enabled, ...current }) => ({
			...current,
			...(on ? {} : { enabled: false }),
		}))
		if (!outcome.ok) {
			setError(outcome.message)
		}
	}

	const contextWindow = effective?.contextWindow.value
	const details = [
		row.name && row.name !== row.upstreamId ? row.upstreamId : "",
		effective?.reasoning.value === "yes" ? levelRange(effective) : "",
		contextWindow != null ? formatTokens(contextWindow) : "",
		priceSummary(effective),
	].filter(Boolean)

	return (
		<div
			className="scroll-my-2 border-t border-editor-group-border first:border-t-0"
			data-testid={`model-row-${row.id}`}
			id={settingsModelElementId(row.id)}>
			<div className="flex min-w-0 items-center gap-3">
				<button
					aria-expanded={open}
					className={cn(
						"flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-0 py-1.5 text-left text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
						!enabled && "opacity-50",
					)}
					onClick={() => page.setOpenModel(open ? null : row.id)}
					type="button">
					<Chevron open={open} />
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[13px]">{modelName(row)}</span>
						{details.length > 0 && !open && (
							<span className="mt-0.5 block truncate text-[12px] text-description">{details.join(" · ")}</span>
						)}
					</span>
				</button>
				{modelStatus(row, isDraft ? undefined : store.state?.availability[row.id], enabled)}
				{!isDraft && row.kind !== "non-chat" && (
					<SmallSwitch
						checked={enabled}
						id={`model-enabled-${row.id}`}
						label={`Use ${modelName(row)}`}
						onChange={(on) => void setEnabled(on)}
					/>
				)}
			</div>
			{error && <Why tone="bad">{error}</Why>}
			{open && <ModelForm connection={connection} isDraft={isDraft} row={row} />}
		</div>
	)
}

const ProviderEdit = ({ connection }: { connection: Extract<Connection, { kind: "provider" }> }) => {
	const page = useModelsPage()
	const [error, setError] = useState<string>()
	const spec = providerSpec(connection.providerId)
	return (
		<div className="mt-3 rounded-md border border-editor-group-border p-3">
			<ProviderConnectionFields connection={connection} onError={setError} spec={spec} />
			<FieldGrid>
				<RequestTimeoutField
					connection={connection}
					onSave={async (requestTimeoutMs) => {
						const outcome = await page.store.saveConnection({ id: connection.id, requestTimeoutMs })
						return outcome.ok ? undefined : outcome.message
					}}
				/>
			</FieldGrid>
			{spec.auth === "sign-in" && (
				<div className="mt-3">
					<ActionButton
						onClick={() =>
							void signOutProvider(connection.providerId).catch((caught) =>
								setError(caught instanceof Error ? caught.message : String(caught)),
							)
						}>
						Sign out
					</ActionButton>
				</div>
			)}
			{error && <Why tone="bad">{error}</Why>}
		</div>
	)
}

/** One connection and the models under it. Only one opens at a time, so the page stays readable. */
export const ConnectionCard = ({ connection, isDraft }: { connection: Connection; isDraft: boolean }) => {
	const page = useModelsPage()
	const { store } = page
	const open = page.openConnection === connection.id
	const saved = store.state?.settings.models.filter((model) => model.connectionId === connection.id) ?? []
	const drafts = page.draftModels.filter((model) => model.connectionId === connection.id)
	const allRows = [...saved, ...drafts]
	const isProvider = connection.kind === "provider"
	const name = isDraft ? connection.name || "New connection" : connectionName(connection)
	const editing = page.isEditing(connection.id)
	const showForm = connection.kind === "openai-compatible" && (isDraft || editing)
	const adding = !isDraft && page.isAdding(connection.id)
	const managedHere =
		connection.kind === "openai-compatible"
			? ["openAiBaseUrl", "openAiHeaders", "azureApiVersion", "azureIdentity"].some(page.managedKey)
			: Object.keys(connection.options).some(page.managedKey)

	const reasons = saved.map((row) => store.state?.availability[row.id]?.reason ?? "")
	const keyMissing =
		(connection.auth.kind === "keychain" && !store.state?.configuredSecrets[connection.auth.secretRef]) ||
		reasons.some((reason) => KEY_MISSING.test(reason))
	const envEmpty = reasons.some((reason) => ENV_EMPTY.test(reason))
	// The form is right there while editing, so it doesn't need saying as well.
	const status =
		isDraft || (open && editing) ? null : keyMissing ? (
			<Status icon="key" tone="warn">
				Key missing
			</Status>
		) : envEmpty ? (
			<Status icon="key" tone="warn">
				Env var empty
			</Status>
		) : null

	return (
		<div
			className={cn(
				"mt-3 min-w-0 scroll-my-2 rounded-md border bg-(--vscode-editor-background)",
				open ? "border-(--vscode-focusBorder)/40" : "border-editor-group-border",
			)}
			data-testid={`connection-${connection.id}`}
			id={settingsConnectionElementId(connection.id)}>
			<div className={cn("flex flex-wrap items-center", open && "border-b border-editor-group-border")}>
				<button
					aria-expanded={open}
					className="flex min-w-[170px] flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2.5 text-left text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					onClick={() => {
						page.setOpenConnection(open ? null : connection.id)
						page.setOpenModel(null)
					}}
					type="button">
					<Chevron open={open} />
					<span className="min-w-0 flex-1">
						<span className="flex items-center gap-1.5">
							<span className="min-w-0 truncate text-[13px] font-medium">{name}</span>
							{managedHere && <LockedIcon title={`${page.organization} manages this connection`} />}
						</span>
						{!isProvider && (
							<span className="mt-0.5 block truncate font-mono text-[12px] text-description">
								{connection.baseUrl || "No base URL yet"}
							</span>
						)}
					</span>
				</button>
				{(status || !isDraft) && (
					<div className="ml-auto flex shrink-0 flex-col items-end gap-1.5 py-2 pr-3 pl-2">
						{status}
						{!isDraft && (
							<ActionButton
								icon={open && editing ? "check" : "edit"}
								onClick={() => {
									const closing = open && editing
									page.setOpenConnection(connection.id)
									page.setEditingConnection(connection.id, !closing)
								}}>
								{open && editing ? "Done editing" : "Edit connection"}
							</ActionButton>
						)}
					</div>
				)}
			</div>
			{open && (
				<div className="px-3 pb-3">
					{showForm && connection.kind === "openai-compatible" && (
						<div className={isDraft ? "pb-1" : "mt-3 rounded-md border border-editor-group-border p-3"}>
							<ConnectionForm connection={connection} isDraft={isDraft} />
						</div>
					)}
					{connection.kind === "provider" && editing && <ProviderEdit connection={connection} />}
					{!isDraft && !isProvider && <SharedDefaults connection={connection} />}
					{!isDraft && (
						<>
							<div className="mt-3 flex items-center justify-between gap-2 pb-1.5">
								<GroupHeading className="p-0">Models</GroupHeading>
								<ActionButton
									aria-expanded={adding}
									icon="add"
									onClick={() => {
										page.setOpenModel(null)
										page.setAddingModels(connection.id)
									}}>
									Add models
								</ActionButton>
							</div>
							{adding && (
								<AddModelsPanel
									connection={connection}
									onClose={() => page.setAddingModels(connection.id, false)}
								/>
							)}
							{allRows.map((row) => (
								<ModelRowView connection={connection} isDraft={drafts.includes(row)} key={row.id} row={row} />
							))}
							<div className="mt-1 flex flex-wrap justify-end border-t border-editor-group-border pt-3">
								<RemoveFlow
									label={`Remove ${isProvider ? name : "connection"}`}
									modelIds={saved.map((row) => row.id)}
									onRemove={() => store.deleteConnection(connection.id)}
									onRemoved={() => {
										page.setOpenConnection(null)
										page.setEditingConnection(connection.id, false)
									}}
									question={
										saved.length
											? `Remove ${name} and its ${plural(saved.length, "model")}?`
											: `Remove ${name}?`
									}
								/>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	)
}
