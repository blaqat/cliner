import type { Connection, ModelRow } from "@shared/model-settings"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { settingsConnectionElementId, settingsModelElementId } from "../settingsTargets"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { AddModelsPanel } from "./AddModelsPanel"
import { ConnectionForm, RequestTimeoutField } from "./ConnectionForm"
import { Chevron, FieldGrid, Icon, LinkButton, LockedIcon, SmallSwitch, Status, Why } from "./fields"
import { ModelForm } from "./ModelForm"
import { useModelsPage } from "./modelsPageContext"
import {
	API_LABELS,
	type ConnectionTest,
	canRunAfter,
	connectionName,
	formatTokens,
	hostOf,
	levelRange,
	modelName,
	PLANNING_CONTEXT,
	priceSummary,
	ROLE_LABELS,
	type RoleKey,
	roleRowId,
	rolesUsingModel,
} from "./modelsView"
import { signOutProvider } from "./ProviderChooser"
import { ProviderConnectionFields } from "./ProviderFields"
import { providerSpec } from "./providerSpecs"
import { RemoveFlow } from "./RemoveFlow"
import { SharedDefaults } from "./SharedDefaults"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const connectionStatus = (test: ConnectionTest | undefined, connection: Connection, keyMissing: boolean) => {
	if (test?.state === "testing") {
		return <Status icon="sync">Testing…</Status>
	}
	if (test?.state === "done") {
		if (test.result === "ok" || test.result === "catalog") {
			return (
				<Status icon="check" tone="ok">
					Connected
				</Status>
			)
		}
		if (test.result === "no-list") {
			return <Status icon="info">No /models</Status>
		}
		if (test.result === "auth") {
			return (
				<Status icon="key" tone="warn">
					Key refused
				</Status>
			)
		}
		return (
			<Status icon="warning" tone="bad">
				Can't reach it
			</Status>
		)
	}
	if (test?.state === "error") {
		return (
			<Status icon="warning" tone="bad">
				Test failed
			</Status>
		)
	}
	if (keyMissing) {
		return (
			<Status icon="key" tone="warn">
				Key missing
			</Status>
		)
	}
	return <Status icon="dash">Not tested</Status>
}

/** Say what the test proved and nothing more. Every outcome is distinct, and each failure says what to do. */
const TestResult = ({
	test,
	connection,
	onRetry,
	onEdit,
}: {
	test: ConnectionTest
	connection: Connection
	onRetry: () => void
	onEdit: () => void
}) => {
	const host = hostOf(connection.baseUrl)
	const auth = connection.auth
	const line = (ok: boolean | null, text: string) => (
		<div
			className={cn(
				"flex items-start gap-1.5",
				ok === true ? "text-success" : ok === false ? "text-error" : "text-description",
			)}>
			<Icon className="mt-px text-[12px]!" name={ok === true ? "check" : ok === false ? "close" : "dash"} />
			<span className="min-w-0">{text}</span>
		</div>
	)
	const keyLine =
		auth.kind === "none"
			? "No key needed"
			: auth.kind === "azure-identity"
				? "Azure sign-in accepted"
				: auth.kind === "environment"
					? `Key from ${auth.variable} accepted`
					: auth.kind === "sdk-account"
						? "Account accepted"
						: "Key accepted"
	const fixes = (...links: [string, () => void][]) => (
		<div className="mt-0.5 flex flex-wrap gap-2 pl-[18px]">
			{links.map(([label, action]) => (
				<LinkButton key={label} onClick={action}>
					{label}
				</LinkButton>
			))}
		</div>
	)
	const box = (tone: "ok" | "warn" | "bad" | "none", children: React.ReactNode) => (
		<div
			className={cn(
				"mt-1.5 grid gap-0.5 rounded-[5px] border px-2 py-1.5 text-[12.5px]",
				tone === "ok"
					? "border-success/40"
					: tone === "warn"
						? "border-warning/40"
						: tone === "bad"
							? "border-error/40"
							: "border-editor-group-border",
			)}
			data-testid="connection-test-result"
			role="status">
			{children}
		</div>
	)
	if (test.state === "testing") {
		return box("none", line(null, "Testing…"))
	}
	if (test.state === "error") {
		return box(
			"bad",
			<>
				{line(false, test.message)}
				{fixes(["Try again", onRetry])}
			</>,
		)
	}
	const reached = connection.baseUrl ? `Reached ${host} in ${test.ms} ms` : `Answered in ${test.ms} ms`
	switch (test.result) {
		case "ok":
			return box(
				"ok",
				<>
					{line(true, reached)}
					{line(true, keyLine)}
					{line(
						true,
						// Models it can't classify count too, so this can't say they're all chat models.
						test.listed === 0 ? "Listed no chat models" : `/models lists ${plural(test.listed, "model")} you can add`,
					)}
				</>,
			)
		case "catalog":
			return box(
				"ok",
				<>
					{line(true, `The catalog knows ${plural(test.listed, "model")} here`)}
					{line(null, "That doesn't prove the key works. Test a model to be sure.")}
				</>,
			)
		case "no-list":
			return box(
				"warn",
				<>
					{line(
						null,
						connection.kind === "provider"
							? "This provider has no list Cline can read, so the key isn't checked here. Test a model to be sure."
							: `${host} has no /models (404). That's fine: type or paste IDs.`,
					)}
				</>,
			)
		case "auth":
			return box(
				"warn",
				<>
					{line(true, `Reached ${host}`)}
					{line(
						false,
						auth.kind === "environment"
							? `${auth.variable} is empty in this window, or the server refused it (401/403).`
							: "The server refused the key (401/403), or there isn't one.",
					)}
					{fixes(["Edit the key", onEdit], ["Try again", onRetry])}
				</>,
			)
		case "network":
			return box(
				"bad",
				<>
					{line(false, `Can't reach ${host}. Is the server running, and is the URL right?`)}
					{fixes(["Try again", onRetry], ["Edit the URL", onEdit])}
				</>,
			)
	}
}

const modelStatus = (
	row: ModelRow,
	available: { available: boolean; reason?: string } | undefined,
	onList: boolean | undefined,
) => {
	if (!row.upstreamId) {
		return (
			<Status icon="warning" tone="warn">
				Needs an ID
			</Status>
		)
	}
	if (onList === false) {
		return (
			<Status icon="warning" tone="warn">
				Not on /models
			</Status>
		)
	}
	if (!available || available.available) {
		return (
			<Status icon="check" tone="ok">
				Ready
			</Status>
		)
	}
	const reason = available.reason ?? "This model can't run."
	return /credentials are missing/i.test(reason) ? (
		<Status icon="key" title={reason} tone="warn">
			Key missing
		</Status>
	) : /environment variable/i.test(reason) ? (
		<Status icon="key" title={reason} tone="warn">
			Env var empty
		</Status>
	) : (
		<Status icon="warning" title={reason} tone="bad">
			Can't run
		</Status>
	)
}

const ModelRowView = ({ row, connection, isDraft }: { row: ModelRow; connection: Connection; isDraft: boolean }) => {
	const page = useModelsPage()
	const { store } = page
	const { openRow } = useSettingsShell()
	const [error, setError] = useState<string>()
	const [blockedRoles, setBlockedRoles] = useState<RoleKey[]>([])
	const open = page.openModel === row.id
	const effective = store.state?.effective[row.id]
	const planning = store.state?.planning[row.id]
	const test = page.tests[connection.id]
	const listIds = test?.state === "done" && test.result === "ok" ? test.models : undefined
	const onList = listIds && !isDraft && !page.keptAnyway[row.id] ? listIds.includes(row.upstreamId) : undefined
	const contextKnown = planning?.contextWindowKnown ?? effective?.contextWindow.value != null
	const contextWindow = effective?.contextWindow.value
	const free =
		listIds
			?.filter(
				(id) =>
					!store.state?.settings.models.some(
						(model) => model.connectionId === connection.id && model.upstreamId === id,
					),
			)
			.slice(0, 2) ?? []

	const enabled = row.enabled !== false
	const setEnabled = async (on: boolean) => {
		setError(undefined)
		const { roles, subagents } = store.state!.settings
		const onAllowedList = subagents.allowed.some((entry) => entry.kind === "model" && entry.modelId === row.id)
		const using = on
			? []
			: [...new Set<RoleKey>([...rolesUsingModel(roles, row.id), ...(onAllowedList ? ["subagents" as const] : [])])]
		setBlockedRoles(using)
		if (using.length) {
			return
		}
		const outcome = await store.updateModel(row.id, ({ enabled: _enabled, ...current }) => ({
			...current,
			...(on ? {} : { enabled: false }),
		}))
		if (!outcome.ok) {
			setError(outcome.message)
		}
	}

	const duplicate = async () => {
		setError(undefined)
		const outcome = await store.duplicate(row.id)
		if (!outcome.ok) {
			setError(outcome.message)
			return
		}
		page.setDraftModels((current) => [...current, outcome.value.draft])
		page.setOpenConnection(connection.id)
		page.setOpenModel(outcome.value.draft.id)
		page.setNote(connection.id, `Copied ${modelName(row)}. Type the new ID.`)
		page.setFocusId(`${settingsModelElementId(outcome.value.draft.id, "upstreamId")}-control`)
	}

	return (
		<div
			className="scroll-my-2 rounded-xs border-b border-editor-group-border last:border-b-0"
			data-testid={`model-row-${row.id}`}
			id={settingsModelElementId(row.id)}>
			<div className="flex min-w-0 items-start gap-1">
				<button
					aria-expanded={open}
					className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 border-0 bg-transparent px-0 py-2.5 text-left text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					onClick={() => page.setOpenModel(open ? null : row.id)}
					type="button">
					<span className="mt-[2px]">
						<Chevron open={open} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
							<span className={cn("min-w-0 truncate text-[13px]", !enabled && "text-description line-through")}>
								{modelName(row)}
							</span>
							{!enabled && <span className="text-[12px] text-description">Off, hidden from model pickers</span>}
							{row.upstreamId && row.kind !== "non-chat" && enabled && effective?.tools.value !== "yes" && (
								<span
									className="inline-flex h-[18px] items-center whitespace-nowrap rounded-[3px] border border-warning/45 px-1.5 text-[11px] leading-none text-warning"
									title="This model can only chat. Open it to turn tools on.">
									No tools
								</span>
							)}
							{row.kind === "non-chat" && (
								<span className="inline-flex h-[18px] items-center whitespace-nowrap rounded-[3px] border border-editor-group-border px-1.5 text-[11px] leading-none text-description">
									not for chat
								</span>
							)}
							<span className="ml-auto flex flex-wrap items-center gap-x-2">
								<span className="whitespace-nowrap text-[12px] text-description">{levelRange(effective)}</span>
								{modelStatus(row, isDraft ? undefined : store.state?.availability[row.id], onList)}
							</span>
						</span>
						<span className="mt-1 block truncate text-[12px] text-description">
							{row.upstreamId || "No model ID yet"} ·{" "}
							{contextKnown && contextWindow != null ? (
								formatTokens(contextWindow)
							) : (
								<span
									className="text-warning"
									title="Context window unknown: Cline plans with 128K and marks the ring with ~">
									{PLANNING_CONTEXT}
								</span>
							)}{" "}
							· {priceSummary(effective)}
						</span>
					</span>
				</button>
				{!isDraft && row.kind !== "non-chat" && (
					<span className="mt-[5px] shrink-0">
						<SmallSwitch
							checked={enabled}
							id={`model-enabled-${row.id}`}
							label={`Use ${modelName(row)}`}
							onChange={(on) => void setEnabled(on)}
						/>
					</span>
				)}
				{!isDraft && (
					<button
						aria-label={`Duplicate ${modelName(row)}`}
						className="mt-[3px] grid size-6 shrink-0 cursor-pointer place-items-center rounded-xs border-0 bg-transparent text-description hover:bg-list-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
						onClick={duplicate}
						title="Duplicate: same details, new ID"
						type="button">
						<Icon name="copy" />
					</button>
				)}
			</div>
			{error && <Why tone="bad">{error}</Why>}
			{blockedRoles.length > 0 && (
				<Why tone="warn">
					Still in use, so it stays on. Pick another for:{" "}
					{blockedRoles.map((role) => (
						<LinkButton key={role} onClick={() => openRow(roleRowId[role])}>
							{ROLE_LABELS[role]}
						</LinkButton>
					))}
				</Why>
			)}
			{onList === false && !open && (
				<div className="pb-1.5 pl-[18px]">
					<Why tone="warn">
						<b className="font-medium">{row.upstreamId}</b> isn't in this connection's /models any more. Cline keeps
						sending it in case the list is incomplete.
					</Why>
					<div className="mt-1 flex flex-wrap gap-2 pl-[18px]">
						{free.map((id) => (
							<LinkButton key={id} onClick={() => void store.saveModels([{ ...row, upstreamId: id, name: "" }])}>
								Use {id}
							</LinkButton>
						))}
						<LinkButton onClick={() => page.keepAnyway(row.id)}>Keep it</LinkButton>
					</div>
				</div>
			)}
			{open && <ModelForm connection={connection} isDraft={isDraft} row={row} />}
		</div>
	)
}

const ProviderLine = ({ connection }: { connection: Extract<Connection, { kind: "provider" }> }) => {
	const page = useModelsPage()
	const editing = page.isEditing(connection.id)
	const [error, setError] = useState<string>()
	const spec = providerSpec(connection.providerId)
	const test = page.tests[connection.id]
	const hasModels = !!page.store.state?.settings.models.some((model) => model.connectionId === connection.id)
	return (
		<>
			<div className="mt-2.5 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-description">
				<span className="min-w-0">{authLine(connection)}</span>
				<span className="flex-1" />
				{spec.auth === "sign-in" && (
					<LinkButton
						onClick={() =>
							void signOutProvider(connection.providerId).catch((caught) =>
								setError(caught instanceof Error ? caught.message : String(caught)),
							)
						}>
						Sign out
					</LinkButton>
				)}
			</div>
			{editing && (
				<div className="pb-1">
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
				</div>
			)}
			{test && (
				<TestResult
					connection={connection}
					onEdit={() => page.setEditingConnection(connection.id, true)}
					onRetry={() => void page.runTest(connection.id, hasModels)}
					test={test}
				/>
			)}
			{error && <Why tone="bad">{error}</Why>}
		</>
	)
}

const authLine = (connection: Connection) => {
	const auth = connection.auth
	return auth.kind === "keychain"
		? "API key in the keychain"
		: auth.kind === "environment"
			? `Key from ${auth.variable}`
			: auth.kind === "azure-identity"
				? "Azure sign-in"
				: auth.kind === "sdk-account"
					? "Signed-in account"
					: connection.kind === "provider"
						? "Its own credentials"
						: "No key"
}

/** One connection and the models under it. Only one opens at a time, so the page stays readable. */
export const ConnectionCard = ({ connection, isDraft }: { connection: Connection; isDraft: boolean }) => {
	const page = useModelsPage()
	const { store } = page
	const open = page.openConnection === connection.id
	const test = page.tests[connection.id]
	const saved = store.state?.settings.models.filter((model) => model.connectionId === connection.id) ?? []
	const drafts = page.draftModels.filter((model) => model.connectionId === connection.id)
	const allRows = [...saved, ...drafts]
	const isProvider = connection.kind === "provider"
	const anchor = settingsConnectionElementId(connection.id)
	const name = isDraft ? connection.name || "New connection" : connectionName(connection)
	const keyMissing =
		connection.auth.kind === "keychain" && !store.state?.configuredSecrets[connection.auth.secretRef] && !isDraft
	const failed = test?.state === "error" || (test?.state === "done" && (test.result === "auth" || test.result === "network"))
	const showForm = connection.kind === "openai-compatible" && (isDraft || page.isEditing(connection.id) || failed)
	const adding = !isDraft && page.isAdding(connection.id)
	const managedHere =
		connection.kind === "openai-compatible"
			? ["openAiBaseUrl", "openAiHeaders", "azureApiVersion", "azureIdentity"].some(page.managedKey)
			: Object.keys(connection.options).some(page.managedKey)
	const notFound =
		test?.state === "done" && test.result === "ok"
			? saved.filter((row) => !test.models.includes(row.upstreamId) && !page.keptAnyway[row.id]).length
			: 0

	const meta = isProvider
		? [authLine(connection), allRows.length ? plural(allRows.length, "model") : ""]
		: [
				connection.baseUrl || "No base URL yet",
				allRows.length ? plural(allRows.length, "model") : "",
				canRunAfter(test) && test?.state === "done" ? `${test.ms} ms` : "",
			]

	return (
		<div
			className={cn(
				"mt-3 min-w-0 scroll-my-2 rounded-md border bg-(--vscode-editor-background)",
				open ? "border-(--vscode-focusBorder)/40" : "border-editor-group-border",
			)}
			data-testid={`connection-${connection.id}`}
			id={anchor}>
			<div className={cn("flex flex-wrap items-start", open && "border-b border-solid border-editor-group-border")}>
				<button
					aria-expanded={open}
					className={cn(
						"flex min-w-[170px] flex-1 cursor-pointer items-start gap-2 border-0 bg-transparent px-3 py-2.5 text-left text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
					)}
					onClick={() => {
						page.setOpenConnection(open ? null : connection.id)
						page.setOpenModel(null)
					}}
					type="button">
					<span className="mt-[2px]">
						<Chevron open={open} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
							<span className="min-w-0 truncate text-[13px] font-medium">{name}</span>
							{managedHere && <LockedIcon title={`${page.organization} manages this connection`} />}
							{notFound > 0 && (
								<span className="inline-flex h-[18px] items-center whitespace-nowrap rounded-[3px] border border-warning/45 px-1.5 text-[11px] leading-none text-warning">
									{notFound} not found
								</span>
							)}
						</span>
						<span className="mt-1 block truncate font-mono text-[12px] text-description">
							{meta.filter(Boolean).join(" · ")}
						</span>
					</span>
				</button>
				<div className="ml-auto flex shrink-0 flex-col items-end gap-1 py-2.5 pr-3 pl-2 text-[12.5px]">
					{connectionStatus(test, connection, keyMissing)}
					{!isDraft && (
						<div className="flex items-center gap-3">
							<LinkButton
								onClick={() => {
									const editing = open && page.isEditing(connection.id)
									page.setOpenConnection(connection.id)
									page.setEditingConnection(connection.id, !editing)
								}}>
								{open && page.isEditing(connection.id) ? "Done editing" : "Edit connection"}
							</LinkButton>
							{open && (
								<LinkButton
									disabled={test?.state === "testing"}
									onClick={() => void page.runTest(connection.id, saved.length > 0)}>
									Test
								</LinkButton>
							)}
						</div>
					)}
				</div>
			</div>
			{open && (
				<div className="px-3 pb-3">
					{connection.kind === "provider" ? (
						<ProviderLine connection={connection} />
					) : showForm ? (
						<ConnectionForm connection={connection} isDraft={isDraft} />
					) : (
						<div className="mt-2.5 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-description">
							<span className="min-w-0">
								{authLine(connection)} · {API_LABELS[connection.apiFormat]}
								{connection.headers.length ? ` · ${plural(connection.headers.length, "header")}` : ""}
							</span>
						</div>
					)}
					{connection.kind === "openai-compatible" && test && !isDraft && (
						<TestResult
							connection={connection}
							onEdit={() => page.setEditingConnection(connection.id, true)}
							onRetry={() => void page.runTest(connection.id, saved.length > 0)}
							test={test}
						/>
					)}
					{page.notes[connection.id] && (
						<div className="mt-1 text-[12px] text-description" role="status">
							{page.notes[connection.id]}
						</div>
					)}
					{!isDraft && !adding && !isProvider && <SharedDefaults connection={connection} />}
					{allRows.map((row) => (
						<ModelRowView connection={connection} isDraft={drafts.includes(row)} key={row.id} row={row} />
					))}
					{!isDraft &&
						(adding ? (
							<AddModelsPanel
								connection={connection}
								onClose={() => page.setAddingModels(connection.id, false)}
								showShared={!isProvider}
							/>
						) : (
							<div className="mt-1.5">
								<LinkButton
									onClick={() => {
										page.setNote(connection.id, undefined)
										page.setOpenModel(null)
										page.setAddingModels(connection.id, true)
									}}>
									<Icon className="text-[12px]!" name="add" />
									Add model
								</LinkButton>
							</div>
						))}
					{!isDraft && (
						<div className="mt-2">
							<RemoveFlow
								label={`Remove ${isProvider ? name : "connection"}`}
								modelIds={saved.map((row) => row.id)}
								onRemove={() => store.deleteConnection(connection.id)}
								onRemoved={() => {
									page.setOpenConnection(null)
									page.setEditingConnection(connection.id, false)
								}}
								question={
									saved.length ? `Remove ${name} and its ${plural(saved.length, "model")}?` : `Remove ${name}?`
								}
								removedName={name}
							/>
						</div>
					)}
				</div>
			)}
		</div>
	)
}
