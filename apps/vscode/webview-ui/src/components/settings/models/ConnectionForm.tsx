import { azureOpenAiDefaultApiVersion } from "@shared/api"
import type { CompatibleConnection, Connection, ConnectionAuth, Header } from "@shared/model-settings"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { settingsConnectionElementId } from "../settingsTargets"
import {
	ActionButton,
	CommitInput,
	ControlRow,
	Field,
	FieldGrid,
	FoldHeader,
	Hint,
	Icon,
	LockedIcon,
	parseSeconds,
	Segmented,
	SmallButton,
	Why,
} from "./fields"
import type { SecretMutation } from "./modelSettingsClient"
import { useModelsPage } from "./modelsPageContext"
import { isAzureUrl, isValidUrl, newId, secretField, secretRef } from "./modelsView"

const AUTH_OPTIONS = [
	{ value: "keychain", label: "API key" },
	{ value: "environment", label: "Env var" },
	{ value: "azure-identity", label: "Azure ID" },
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
			placeholder={configured ? "Saved" : placeholder}
			secret
			value=""
		/>
		{configured && requiredNote && <Hint>{requiredNote}</Hint>}
		{configured && onRemove && (
			<div className="mt-1.5">
				<ActionButton danger disabled={disabled} icon="trash" onClick={() => void onRemove()}>
					Remove {label}
				</ActionButton>
			</div>
		)}
	</>
)

/** The connection's own fields. A draft becomes a saved connection as soon as it has a base URL; after that each field writes as it's left. */
export const ConnectionForm = ({ connection, isDraft }: { connection: CompatibleConnection; isDraft: boolean }) => {
	const page = useModelsPage()
	const { store, managedKey, organization } = page
	const [authDraft, setAuthDraft] = useState<AuthKind>()
	const [moreOpen, setMoreOpen] = useState(false)
	const [error, setError] = useState<string>()
	const [pendingHeaders, setPendingHeaders] = useState<{ id: string; name: string; value: string }[]>([])

	const urlLocked = managedKey("openAiBaseUrl")
	const headersLocked = managedKey("openAiHeaders")
	const versionLocked = managedKey("azureApiVersion")
	const identityLocked = managedKey("azureIdentity")
	const lockedWords = [urlLocked && "base URL", headersLocked && "headers", versionLocked && "Azure version"].filter(Boolean)

	const anchor = settingsConnectionElementId(connection.id)

	const save = async (change: Partial<CompatibleConnection>, secrets?: SecretMutation[]): Promise<string | undefined> => {
		setError(undefined)
		if (isDraft) {
			page.updateDraft(connection.id, change, secrets)
			// Once it has somewhere to go it's real, so a reload can't lose it.
			const next = { ...connection, ...change }
			return next.baseUrl && isValidUrl(next.baseUrl) ? page.commitDraft(next) : undefined
		}
		const outcome = await store.saveConnection({ id: connection.id, ...change }, secrets ?? [])
		if (!outcome.ok) {
			setError(outcome.message)
			return outcome.message
		}
		return undefined
	}

	const authKind: AuthKind = authDraft ?? (connection.auth.kind === "sdk-account" ? "keychain" : connection.auth.kind)
	// A connection that moved over keeps its key under its old field name.
	const keyRef = connection.auth.kind === "keychain" ? connection.auth.secretRef : secretRef(connection.id, "apiKey")
	const keyField = secretField(keyRef)
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
			const removed = await store.saveConnection({ id: connection.id }, [{ field: keyField, operation: "delete" }])
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
			// The host moves the value back into the header, since this is what asks for it in plain text.
			if (!isDraft) {
				const unlocked = await store.saveConnection({ id: connection.id }, [
					{ field: secretField(header.secretRef), operation: "unlock" },
				])
				if (!unlocked.ok) {
					setError(unlocked.message)
				}
				return
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
				{ field: secretField(header.secretRef), operation: "delete" },
			])
			if (!removed.ok) {
				setError(removed.message)
				return
			}
		}
		await saveHeaders(connection.headers.filter((entry) => entry.id !== header.id))
	}

	// A gateway in front of Azure has its own host, and a saved version has to stay reachable to clear it.
	const azure =
		isAzureUrl(connection.baseUrl) ||
		/\/openai(\/|$)/.test(connection.baseUrl ?? "") ||
		connection.auth.kind === "azure-identity" ||
		!!connection.azureApiVersion
	const inputIds = `${anchor}-control`
	// A fix link lands on what needs fixing: the key, once the URL is fine.
	const keyNeeded = authKind === "keychain" && !keyConfigured && !!connection.baseUrl && isValidUrl(connection.baseUrl)

	return (
		<div data-testid={`connection-form-${connection.id}`}>
			<FieldGrid className="mt-0 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
				<Field label="Name">
					<CommitInput
						label="Connection name"
						onCommit={(text) => save({ name: text.trim() })}
						placeholder="Company gateway"
						value={connection.name}
					/>
				</Field>
				<Field
					label={
						<span className="inline-flex items-center gap-1">
							Base URL{urlLocked && <LockedIcon title={`${organization} manages this`} />}
						</span>
					}>
					<CommitInput
						disabled={urlLocked}
						id={keyNeeded ? undefined : inputIds}
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
			<div className="mt-2">
				<ControlRow label="Key">
					<Segmented<AuthKind>
						disabled={identityLocked}
						label="Key"
						onChange={(kind) => void changeAuth(kind)}
						options={AUTH_OPTIONS}
						value={authKind}
						wrap
					/>
				</ControlRow>
			</div>
			{authKind === "keychain" && (
				<SecretField
					configured={keyConfigured}
					id={keyNeeded ? inputIds : undefined}
					label="API key"
					onRemove={() => save({ auth: { kind: "none" } }, [{ field: keyField, operation: "delete" }])}
					onSet={(value) =>
						save({ auth: { kind: "keychain", secretRef: keyRef } }, [{ field: keyField, operation: "set", value }])
					}
					placeholder="sk-…"
				/>
			)}
			{authKind === "environment" && (
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
								{ field: keyField, operation: "delete" },
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
			)}
			<div className="mt-2">
				<ControlRow label="API type">
					<Segmented<"chat" | "responses">
						label="API type"
						onChange={(apiFormat) => void save({ apiFormat })}
						options={[
							{ value: "chat", label: "Chat" },
							{ value: "responses", label: "Responses" },
						]}
						value={connection.apiFormat}
						wrap
					/>
				</ControlRow>
			</div>

			<div className="mt-3 flex flex-wrap items-center gap-x-1.5 text-[13px] text-foreground">
				<span>Custom headers</span>
			</div>
			{connection.headers.map((header) => (
				<div
					className="mt-1.5 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto] items-center gap-1.5"
					key={header.id}>
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
							onSet={(value) => save({}, [{ field: secretField(header.secretRef), operation: "set", value }])}
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
						title={header.storage === "secret" ? "Locked. Click to unlock." : "Lock this value"}
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
				<div className="mt-1.5 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-1.5" key={pending.id}>
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
				<div className="mt-2">
					<ActionButton
						icon="add"
						onClick={() => setPendingHeaders((current) => [...current, { id: newId(), name: "", value: "" }])}>
						Add header
					</ActionButton>
				</div>
			)}

			<FoldHeader onToggle={() => setMoreOpen((current) => !current)} open={moreOpen} title="More" />
			{moreOpen && (
				<FieldGrid className="mt-0">
					{azure && (
						<Field label="Azure API version">
							<CommitInput
								disabled={versionLocked}
								label="Azure API version"
								mono
								onCommit={(text) => save({ azureApiVersion: text.trim() || null })}
								placeholder={`e.g. ${azureOpenAiDefaultApiVersion}`}
								value={connection.azureApiVersion ?? ""}
							/>
						</Field>
					)}
					<RequestTimeoutField connection={connection} onSave={(requestTimeoutMs) => save({ requestTimeoutMs })} />
				</FieldGrid>
			)}
			{isDraft && (urlLocked || (store.state?.settings.connections.length ?? 0) + page.drafts.length > 1) && (
				<div className="mt-3 flex flex-wrap items-center gap-2">
					{urlLocked && (
						<SmallButton onClick={() => void page.commitDraft(connection).then(setError)} primary>
							Save connection
						</SmallButton>
					)}
					{(store.state?.settings.connections.length ?? 0) + page.drafts.length > 1 && (
						<ActionButton onClick={() => page.dropDraft(connection.id)}>Cancel</ActionButton>
					)}
				</div>
			)}
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
	<Field id={id} label="Request timeout (seconds)">
		<CommitInput
			label="Request timeout"
			mono
			onCommit={(text) => {
				const parsed = parseSeconds(text)
				return "error" in parsed ? parsed.error : onSave(parsed.value)
			}}
			placeholder="Default"
			value={connection.requestTimeoutMs == null ? "" : String(connection.requestTimeoutMs / 1000)}
		/>
	</Field>
)
