import { azureOpenAiDefaultApiVersion } from "@shared/api"
import type { CompatibleConnection, Connection, ConnectionAuth, Header } from "@shared/model-settings"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { settingsConnectionElementId } from "../settingsTargets"
import {
	CommitInput,
	Field,
	FieldGrid,
	FoldHeader,
	Hint,
	Icon,
	LinkButton,
	LockedIcon,
	parseSeconds,
	Segmented,
	SmallButton,
	Why,
} from "./fields"
import { useModelsPage } from "./modelsPageContext"
import type { SecretMutation } from "./modelSettingsClient"
import { canRunAfter, isAzureUrl, isValidUrl, newId, secretRef } from "./modelsView"

/** Starting points that only fill in the form. URLs are the servers' own defaults; nothing here is a model fact. */
const PRESETS: { label: string; change: Partial<CompatibleConnection> }[] = [
	{ label: "vLLM", change: { name: "vLLM", baseUrl: "http://localhost:8000/v1", auth: { kind: "none" }, apiFormat: "chat" } },
	{ label: "LiteLLM proxy", change: { name: "LiteLLM", baseUrl: "http://localhost:4000/v1", apiFormat: "chat" } },
	{ label: "Azure OpenAI", change: { name: "Azure OpenAI", auth: { kind: "azure-identity" }, apiFormat: "chat" } },
	{ label: "A gateway", change: { name: "Company gateway", apiFormat: "chat" } },
]

const AUTH_OPTIONS = [
	{ value: "keychain", label: "API key" },
	{ value: "environment", label: "Env var" },
	{ value: "azure-identity", label: "Azure identity" },
	{ value: "none", label: "None" },
] as const

type AuthKind = (typeof AUTH_OPTIONS)[number]["value"]

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MASKED = /^(?:[*•●]{2,}|<redacted>|\[redacted\]|masked$)/i

/** A secret box: write-only. A saved value is never fetched or shown; typing replaces it. */
export const SecretField = ({
	label,
	configured,
	onSet,
	onRemove,
	requiredNote,
	disabled,
	placeholder,
	id,
}: {
	label: string
	configured: boolean
	onSet: (value: string) => Promise<string | undefined>
	onRemove?: () => Promise<string | undefined>
	/** Why this can't be removed. Shown instead of a way to remove it. */
	requiredNote?: string
	disabled?: boolean
	placeholder: string
	id?: string
}) => (
	<>
		<CommitInput
			clearAfterCommit
			disabled={disabled}
			id={id}
			label={label}
			mono
			onCommit={(text) => {
				const value = text.trim()
				if (!value) {
					return undefined
				}
				return MASKED.test(value) ? "Type the whole value, not a masked one." : onSet(value)
			}}
			placeholder={configured ? "Saved in the keychain. Type to replace it." : placeholder}
			secret
			value=""
		/>
		{configured && requiredNote && <Hint>{requiredNote}</Hint>}
		{configured && onRemove && (
			<Hint>
				<LinkButton disabled={disabled} onClick={() => void onRemove()}>
					Remove the saved value
				</LinkButton>
			</Hint>
		)}
	</>
)

/** The connection's own fields. A draft edits locally until Test saves it; a saved connection writes each field as it's left. */
export const ConnectionForm = ({ connection, isDraft }: { connection: CompatibleConnection; isDraft: boolean }) => {
	const page = useModelsPage()
	const { store, managedKey, organization } = page
	const [authDraft, setAuthDraft] = useState<AuthKind>()
	const [moreOpen, setMoreOpen] = useState(false)
	const [error, setError] = useState<string>()
	const [pendingHeaders, setPendingHeaders] = useState<{ id: string; name: string; value: string }[]>([])
	const [testError, setTestError] = useState<string>()

	const urlLocked = managedKey("openAiBaseUrl")
	const headersLocked = managedKey("openAiHeaders")
	const versionLocked = managedKey("azureApiVersion")
	const identityLocked = managedKey("azureIdentity")
	const lockedWords = [urlLocked && "base URL", headersLocked && "headers", versionLocked && "Azure version"].filter(Boolean)

	const anchor = settingsConnectionElementId(connection.id)
	const test = page.tests[connection.id]

	const save = async (change: Partial<CompatibleConnection>, secrets?: SecretMutation[]): Promise<string | undefined> => {
		setError(undefined)
		if (isDraft) {
			page.updateDraft(connection.id, change, secrets)
			return undefined
		}
		const outcome = await store.saveConnection({ id: connection.id, ...change }, secrets ?? [])
		if (!outcome.ok) {
			setError(outcome.message)
			return outcome.message
		}
		return undefined
	}

	const authKind: AuthKind = authDraft ?? (connection.auth.kind === "sdk-account" ? "keychain" : connection.auth.kind)
	const keyRef = secretRef(connection.id, "apiKey")
	const keyConfigured = !!store.state?.configuredSecrets[keyRef]

	const changeAuth = async (kind: AuthKind) => {
		if (kind === "environment") {
			setAuthDraft("environment")
			return
		}
		setAuthDraft(undefined)
		const auth: ConnectionAuth = kind === "keychain" ? { kind: "keychain", secretRef: keyRef } : { kind }
		// A key left behind would sit in the keychain with nothing pointing at it.
		if (!isDraft && connection.auth.kind === "keychain" && kind !== "keychain" && keyConfigured) {
			const removed = await store.saveConnection({ id: connection.id }, [{ field: "apiKey", operation: "delete" }])
			if (!removed.ok) {
				setError(removed.message)
				return
			}
		}
		await save({ auth })
	}

	const saveHeaders = (headers: Header[], secrets?: SecretMutation[]) => save({ headers }, secrets)

	const addHeader = async (pending: { id: string; name: string; value: string }) => {
		if (!HEADER_NAME.test(pending.name)) {
			return "Header names can't have spaces or punctuation like : or /."
		}
		if (connection.headers.some((header) => header.name.toLowerCase() === pending.name.toLowerCase())) {
			return "There's already a header with that name."
		}
		const failed = await saveHeaders([
			...connection.headers,
			{ id: pending.id, name: pending.name, storage: "plain", value: pending.value },
		])
		if (!failed) {
			setPendingHeaders((current) => current.filter((entry) => entry.id !== pending.id))
		}
		return failed
	}

	const lockHeader = async (header: Header) => {
		if (header.storage === "secret") {
			// Unlocking can't bring the value back: it never leaves the keychain.
			if (!isDraft) {
				const removed = await store.saveConnection({ id: connection.id }, [
					{ field: `header-${header.id}`, operation: "delete" },
				])
				if (!removed.ok) {
					setError(removed.message)
					return
				}
			}
			await saveHeaders(
				connection.headers.map((entry) =>
					entry.id === header.id ? { id: header.id, name: header.name, storage: "plain", value: "" } : entry,
				),
			)
			return
		}
		if (!header.value) {
			setError("Type the header's value first, then lock it.")
			return
		}
		const field = `header-${header.id}`
		await saveHeaders(
			connection.headers.map((entry) =>
				entry.id === header.id
					? { id: header.id, name: header.name, storage: "secret", secretRef: secretRef(connection.id, field) }
					: entry,
			),
			[{ field, operation: "set", value: header.value }],
		)
	}

	const removeHeader = async (header: Header) => {
		if (header.storage === "secret" && !isDraft) {
			const removed = await store.saveConnection({ id: connection.id }, [
				{ field: `header-${header.id}`, operation: "delete" },
			])
			if (!removed.ok) {
				setError(removed.message)
				return
			}
		}
		await saveHeaders(connection.headers.filter((entry) => entry.id !== header.id))
	}

	const runTest = async () => {
		setTestError(undefined)
		if (authKind === "environment" && connection.auth.kind !== "environment") {
			setTestError("Name the env var first.")
			return
		}
		if (isDraft) {
			setTestError(await page.saveAndTestDraft(connection))
			return
		}
		await page.runTest(connection.id, !!store.state?.settings.models.some((model) => model.connectionId === connection.id))
	}

	const azure = isAzureUrl(connection.baseUrl) || connection.auth.kind === "azure-identity"
	const inputIds = `${anchor}-control`

	return (
		<div data-testid={`connection-form-${connection.id}`}>
			{isDraft && !connection.baseUrl && (
				<>
					<div className="mt-1.5 text-[11px] text-description">Start from</div>
					<div className="mt-0.5 flex flex-wrap gap-1">
						{PRESETS.map((preset) => (
							<button
								className="h-[22px] cursor-pointer whitespace-nowrap rounded-full border border-solid border-editor-group-border bg-transparent px-2 text-[11px] text-description hover:text-foreground"
								key={preset.label}
								onClick={() => void save(preset.change)}
								type="button">
								{preset.label}
							</button>
						))}
					</div>
				</>
			)}
			<FieldGrid>
				<Field label="Name">
					<CommitInput
						label="Connection name"
						onCommit={(text) => save({ name: text.trim() })}
						placeholder="Company gateway"
						value={connection.name}
					/>
				</Field>
			</FieldGrid>
			<FieldGrid>
				<Field
					label={
						<span className="inline-flex items-center gap-1">
							Base URL{urlLocked && <LockedIcon title={`${organization} manages this`} />}
						</span>
					}>
					<CommitInput
						disabled={urlLocked}
						id={inputIds}
						label="Base URL"
						mono
						onCommit={(text) => {
							const value = text.trim()
							if (value && !isValidUrl(value)) {
								return "That isn't a URL. It starts with http:// or https://."
							}
							return save({ baseUrl: value || null })
						}}
						placeholder="https://gateway.example/v1"
						value={connection.baseUrl ?? ""}
					/>
				</Field>
			</FieldGrid>
			{lockedWords.length > 0 && (
				<Why tone="warn">
					{organization} sets the {lockedWords.join(", ")} here. Ask your admin to change{" "}
					{lockedWords.length === 1 ? "it" : "them"}.
				</Why>
			)}
			<div className="mt-2 mb-0.5 text-[11px] text-description">Key</div>
			<Segmented<AuthKind>
				disabled={identityLocked}
				label="Key"
				onChange={(kind) => void changeAuth(kind)}
				options={AUTH_OPTIONS}
				value={authKind}
				wrap
			/>
			<div className="mt-1">
				{authKind === "keychain" && (
					<Field hint="Saved in VS Code's keychain." label="API key">
						<SecretField
							configured={keyConfigured}
							label="API key"
							onRemove={() => save({ auth: { kind: "none" } }, [{ field: "apiKey", operation: "delete" }])}
							onSet={(value) =>
								save({ auth: { kind: "keychain", secretRef: keyRef } }, [
									{ field: "apiKey", operation: "set", value },
								])
							}
							placeholder="sk-…"
						/>
					</Field>
				)}
				{authKind === "environment" && (
					<Field hint="Read from this window's environment." label="Env var name">
						<CommitInput
							label="Env var name"
							mono
							onCommit={async (text) => {
								const variable = text.trim()
								if (!ENV_NAME.test(variable)) {
									return "Letters, digits and _, not starting with a digit."
								}
								if (!isDraft && connection.auth.kind === "keychain" && keyConfigured) {
									const removed = await store.saveConnection({ id: connection.id }, [
										{ field: "apiKey", operation: "delete" },
									])
									if (!removed.ok) {
										return removed.message
									}
								}
								const failed = await save({ auth: { kind: "environment", variable } })
								if (!failed) {
									setAuthDraft(undefined)
								}
								return failed
							}}
							placeholder="MY_GATEWAY_KEY"
							value={connection.auth.kind === "environment" ? connection.auth.variable : ""}
						/>
					</Field>
				)}
				{authKind === "azure-identity" && <Hint>Uses your Azure sign-in (Azure Identity). No key is stored.</Hint>}
				{authKind === "none" && <Hint>For local servers that don't check a key.</Hint>}
			</div>
			<div className="mt-2 mb-0.5 text-[11px] text-description">API type</div>
			<Segmented<"chat" | "responses">
				label="API type"
				onChange={(apiFormat) => void save({ apiFormat })}
				options={[
					{ value: "chat", label: "Chat Completions" },
					{ value: "responses", label: "Responses" },
				]}
				value={connection.apiFormat}
				wrap
			/>
			<Hint>
				Chat Completions fits most servers and local models. Use Responses when the server offers it. A model can override
				this.
			</Hint>

			<div className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11px] text-description">
				<span>Custom headers</span>
				{connection.headers.some((header) => header.storage === "secret") && (
					<span className="opacity-70">locked values stay in the keychain</span>
				)}
			</div>
			{connection.headers.map((header) => (
				<div className="mt-1 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto] items-center gap-1" key={header.id}>
					<CommitInput
						disabled={headersLocked}
						label="Header name"
						mono
						onCommit={(text) => {
							const name = text.trim()
							if (!HEADER_NAME.test(name)) {
								return "Header names can't have spaces or punctuation like : or /."
							}
							return saveHeaders(
								connection.headers.map((entry) => (entry.id === header.id ? { ...entry, name } : entry)),
							)
						}}
						placeholder="Name"
						value={header.name}
					/>
					{header.storage === "plain" ? (
						<CommitInput
							disabled={headersLocked}
							label="Header value"
							mono
							onCommit={(text) =>
								saveHeaders(
									connection.headers.map((entry) =>
										entry.id === header.id ? { ...header, value: text } : entry,
									),
								)
							}
							placeholder="Value"
							value={header.value}
						/>
					) : (
						<SecretField
							configured={!!store.state?.configuredSecrets[header.secretRef]}
							disabled={headersLocked}
							label="Header value"
							onSet={(value) => save({}, [{ field: `header-${header.id}`, operation: "set", value }])}
							placeholder="Value"
						/>
					)}
					<button
						aria-label={header.storage === "secret" ? `Unlock ${header.name}` : `Lock ${header.name}`}
						className={cn(
							"grid size-[22px] cursor-pointer place-items-center rounded-xs border-0 bg-transparent text-description hover:bg-list-hover hover:text-foreground disabled:cursor-not-allowed",
							header.storage === "secret" && "text-warning hover:text-warning",
						)}
						disabled={headersLocked}
						onClick={() => void lockHeader(header)}
						title={
							header.storage === "secret"
								? "Locked: in the keychain, masked everywhere. Unlocking forgets the value."
								: "Lock it: keeps the value in the keychain"
						}
						type="button">
						<Icon name="lock" />
					</button>
					<button
						aria-label={`Remove ${header.name}`}
						className="grid size-[22px] cursor-pointer place-items-center rounded-xs border-0 bg-transparent text-description hover:bg-list-hover hover:text-foreground disabled:cursor-not-allowed"
						disabled={headersLocked}
						onClick={() => void removeHeader(header)}
						title="Remove"
						type="button">
						<Icon name="close" />
					</button>
				</div>
			))}
			{pendingHeaders.map((pending) => (
				<div className="mt-1 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-1" key={pending.id}>
					<CommitInput
						label="Header name"
						mono
						onCommit={(text) => {
							const name = text.trim()
							if (!name) {
								return undefined
							}
							return addHeader({ ...pending, name })
						}}
						placeholder="Name"
						value={pending.name}
					/>
					<CommitInput
						label="Header value"
						mono
						onCommit={(value) =>
							setPendingHeaders((current) =>
								current.map((entry) => (entry.id === pending.id ? { ...entry, value } : entry)),
							)
						}
						placeholder="Value"
						value={pending.value}
					/>
					<button
						aria-label="Remove"
						className="grid size-[22px] cursor-pointer place-items-center rounded-xs border-0 bg-transparent text-description hover:bg-list-hover"
						onClick={() => setPendingHeaders((current) => current.filter((entry) => entry.id !== pending.id))}
						type="button">
						<Icon name="close" />
					</button>
				</div>
			))}
			{!headersLocked && (
				<div className="mt-1.5">
					<LinkButton
						onClick={() => setPendingHeaders((current) => [...current, { id: newId(), name: "", value: "" }])}>
						<Icon className="text-[11px]!" name="add" />
						Add header
					</LinkButton>
				</div>
			)}

			<FoldHeader
				onToggle={() => setMoreOpen((current) => !current)}
				open={moreOpen}
				summary={azure ? "Azure API version, request timeout" : "request timeout"}
				title="More"
			/>
			{moreOpen && (
				<FieldGrid className="mt-0">
					{azure && (
						<Field label="Azure API version">
							<CommitInput
								disabled={versionLocked}
								label="Azure API version"
								mono
								onCommit={(text) => save({ azureApiVersion: text.trim() || null })}
								placeholder={`Default: ${azureOpenAiDefaultApiVersion}`}
								value={connection.azureApiVersion ?? ""}
							/>
						</Field>
					)}
					<RequestTimeoutField connection={connection} onSave={(requestTimeoutMs) => save({ requestTimeoutMs })} />
				</FieldGrid>
			)}
			<div className="mt-1.5 flex flex-wrap items-center gap-2">
				<SmallButton disabled={test?.state === "testing"} onClick={runTest} primary>
					{test?.state === "testing" ? "Testing…" : "Test connection"}
				</SmallButton>
				{!isDraft && canRunAfter(test) && (
					<LinkButton onClick={() => page.setEditingConnection(connection.id, false)}>Done</LinkButton>
				)}
				{isDraft && (store.state?.settings.connections.length ?? 0) + page.drafts.length > 1 && (
					<LinkButton onClick={() => page.dropDraft(connection.id)}>Cancel</LinkButton>
				)}
			</div>
			{testError && <Why tone="warn">{testError}</Why>}
			{error && <Why tone="bad">{error}</Why>}
		</div>
	)
}

export const RequestTimeoutField = ({
	connection,
	onSave,
	id,
}: {
	connection: Connection
	onSave: (milliseconds: number | null) => Promise<string | undefined>
	id?: string
}) => (
	<Field id={id} label="Request timeout">
		<CommitInput
			label="Request timeout"
			mono
			onCommit={(text) => {
				const parsed = parseSeconds(text)
				return "error" in parsed ? parsed.error : onSave(parsed.value)
			}}
			placeholder="Seconds. Empty uses Models › Advanced"
			value={connection.requestTimeoutMs == null ? "" : String(connection.requestTimeoutMs / 1000)}
		/>
	</Field>
)
