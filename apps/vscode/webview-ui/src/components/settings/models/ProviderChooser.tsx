import type { ProviderConnection } from "@shared/model-settings"
import { EmptyRequest } from "@shared/proto/cline/common"
import type { ProviderListing } from "@shared/proto/cline/models"
import { ResolveProviderModelsRequest } from "@shared/proto/cline/models"
import { useEffect, useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderListings } from "@/hooks/useProviderListings"
import { AccountServiceClient, ModelsServiceClient, OcaAccountServiceClient } from "@/services/grpc-client"
import { AddModelsPanel } from "./AddModelsPanel"
import { SecretField } from "./ConnectionForm"
import { ActionButton, Field, FieldGrid, Hint, LinkButton, SmallButton, Why } from "./fields"
import type { DiscoveredModel } from "./modelSettingsClient"
import { useModelsPage } from "./modelsPageContext"
import { isValidUrl, newId, secretRef } from "./modelsView"
import { ProviderFieldControl } from "./ProviderFields"
import {
	chooserProviders,
	FIRST_PROVIDER_COUNT,
	isFieldVisible,
	type ProviderField,
	providerSpec,
	signInCopy,
} from "./providerSpecs"

const SIGN_IN: Record<string, () => Promise<unknown>> = {
	cline: () => AccountServiceClient.accountLoginClicked(EmptyRequest.create()),
	"cline-pass": () => AccountServiceClient.accountLoginClicked(EmptyRequest.create()),
	"openai-codex": () => AccountServiceClient.openAiCodexSignIn(EmptyRequest.create()),
	oca: () => OcaAccountServiceClient.ocaAccountLoginClicked(EmptyRequest.create()),
}

const SIGN_OUT: Record<string, () => Promise<unknown>> = {
	cline: () => AccountServiceClient.accountLogoutClicked(EmptyRequest.create()),
	"cline-pass": () => AccountServiceClient.accountLogoutClicked(EmptyRequest.create()),
	"openai-codex": () => AccountServiceClient.openAiCodexSignOut(EmptyRequest.create()),
	oca: () => OcaAccountServiceClient.ocaAccountLogoutClicked(EmptyRequest.create()),
}

export const signOutProvider = async (providerId: string) => {
	await SIGN_OUT[providerId]?.()
}

/** What the maintained catalog lists for a provider, for when it has no /models of its own. */
const useCatalogModels = (providerId: string | undefined) => {
	const [models, setModels] = useState<DiscoveredModel[]>([])
	useEffect(() => {
		setModels([])
		if (!providerId) {
			return
		}
		let current = true
		ModelsServiceClient.resolveProviderModels(ResolveProviderModelsRequest.create({ providerId, forceRefresh: false }))
			.then((response) => {
				if (current) {
					setModels(
						Object.entries(response.models ?? {}).map(([upstreamId, info]) => ({
							upstreamId,
							name: info.name || upstreamId,
							classification: "chat" as const,
							source: "catalog" as const,
						})),
					)
				}
			})
			.catch(() => {
				// Discovery and manual IDs still work without the catalog.
			})
		return () => {
			current = false
		}
	}, [providerId])
	return models
}

const ProviderSetup = ({
	listing,
	onBack,
	onDone,
}: {
	listing: ProviderListing
	onBack: () => void
	onDone: (connectionId: string) => void
}) => {
	const page = useModelsPage()
	const spec = providerSpec(listing.id, listing)
	const [id] = useState(newId)
	const [options, setOptions] = useState<Record<string, unknown>>(() => {
		const select = spec.fields.filter((field) => field.type === "select" && field.choices?.length)
		return Object.fromEntries(select.map((field) => [field.id, field.choices?.[0].value]))
	})
	const [baseUrl, setBaseUrl] = useState<string>()
	const [secrets, setSecrets] = useState<Record<string, string>>({})
	const [missing, setMissing] = useState<string>()
	const [error, setError] = useState<string>()
	const [connection, setConnection] = useState<ProviderConnection>()
	const [signingIn, setSigningIn] = useState<string>()
	const catalog = useCatalogModels(connection ? listing.id : undefined)

	const visible = spec.fields.filter((field) => isFieldVisible(field, options))
	// A locked value is the organization's: there's nothing for the person to fill in.
	const asked = visible.filter((field) => field.required && !page.managedKey(field.id))

	const connect = async () => {
		const empty =
			(spec.auth === "keychain" && !secrets.apiKey && "apiKey") ||
			asked.find((field) => !(field.slot === "secret" ? secrets[field.id] : options[field.id]))?.id
		if (empty) {
			setMissing(empty)
			return
		}
		setMissing(undefined)
		const fieldSecrets = visible.filter((field) => field.slot === "secret" && secrets[field.id])
		const keyed = (spec.auth === "keychain" || spec.auth === "optional-key") && !!secrets.apiKey
		const next: ProviderConnection = {
			id,
			name: listing.name,
			kind: "provider",
			providerId: listing.id,
			baseUrl: baseUrl || null,
			auth:
				spec.auth === "sign-in"
					? { kind: "sdk-account", providerId: listing.id }
					: keyed
						? { kind: "keychain", secretRef: secretRef(id, "apiKey") }
						: { kind: "none" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			options: options as ProviderConnection["options"],
			secretRefs: Object.fromEntries(fieldSecrets.map((field) => [field.id, secretRef(id, field.id)])),
		}
		const mutations = [
			...(keyed ? [{ field: "apiKey", operation: "set" as const, value: secrets.apiKey }] : []),
			...fieldSecrets.map((field) => ({ field: field.id, operation: "set" as const, value: secrets[field.id] })),
		]
		const outcome = await page.store.saveConnection(next, mutations)
		if (!outcome.ok) {
			setError(outcome.message)
			return
		}
		setError(undefined)
		setConnection(next)
	}

	const signIn = async () => {
		setSigningIn("Opens your browser. Finish signing in there.")
		try {
			await SIGN_IN[listing.id]?.()
			await connect()
		} catch (caught) {
			setSigningIn(undefined)
			setError(caught instanceof Error ? caught.message : String(caught))
		}
	}

	if (connection) {
		return (
			<AddModelsPanel
				connection={connection}
				extraModels={catalog}
				onClose={() => {
					page.setOpenConnection(connection.id)
					onDone(connection.id)
				}}
			/>
		)
	}

	const fieldError = (fieldId: string) => (missing === fieldId ? `${listing.name} needs this.` : undefined)
	const controlFor = (field: ProviderField) =>
		field.slot === "secret" ? (
			<Field error={fieldError(field.id)} key={field.id} label={field.label}>
				<SecretField
					configured={!!secrets[field.id]}
					label={field.label}
					onSet={async (value) => {
						setSecrets((current) => ({ ...current, [field.id]: value }))
						return undefined
					}}
					placeholder="Paste value"
				/>
			</Field>
		) : (
			<ProviderFieldControl
				error={fieldError(field.id)}
				field={field}
				key={field.id}
				locked={page.managedKey(field.id)}
				onChange={(value) => {
					if (typeof value === "string" && value && field.slot === "base-url") {
						if (!isValidUrl(value)) {
							return "That isn't a URL. It starts with http:// or https://."
						}
						setBaseUrl(value)
						return undefined
					}
					if (field.slot === "base-url") {
						setBaseUrl(undefined)
						return undefined
					}
					setOptions((current) => ({ ...current, [field.id]: value }))
					return undefined
				}}
				value={field.slot === "base-url" ? baseUrl : options[field.id]}
			/>
		)

	return (
		<div data-testid={`provider-setup-${listing.id}`}>
			<div className="text-[13px] font-medium">{listing.name}</div>
			{spec.note && <div className="text-[12px] text-description">{spec.note}</div>}
			<FieldGrid>
				{(spec.auth === "keychain" || spec.auth === "optional-key") && (
					<Field
						error={fieldError("apiKey") && `${listing.name} needs a key.`}
						hint={spec.signupUrl ? <a href={spec.signupUrl}>Get a key from {listing.name}</a> : undefined}
						label={spec.auth === "optional-key" ? "API key (optional)" : "API key"}>
						<SecretField
							configured={!!secrets.apiKey}
							label="API key"
							onSet={async (value) => {
								setSecrets((current) => ({ ...current, apiKey: value }))
								return undefined
							}}
							placeholder="Paste key"
						/>
					</Field>
				)}
				{visible.map(controlFor)}
			</FieldGrid>
			{signingIn && <Hint>{signingIn}</Hint>}
			{error && <Why tone="bad">{error}</Why>}
			<div className="mt-1.5 flex flex-wrap items-center gap-2">
				{spec.auth === "sign-in" ? (
					<>
						<SmallButton onClick={signIn} primary>
							Sign in
						</SmallButton>
						<span className="text-[12px] text-description">{signInCopy(spec)}</span>
					</>
				) : (
					<SmallButton onClick={connect} primary>
						{spec.auth === "keychain" || spec.fields.length ? "Connect" : "Use it"}
					</SmallButton>
				)}
				<ActionButton onClick={onBack}>Back</ActionButton>
			</div>
		</div>
	)
}

/** Every provider in the catalog, but small: a filter and a few chips, opening one form at a time. */
export const ProviderChooser = ({ onClose, onAddConnection }: { onClose: () => void; onAddConnection: () => void }) => {
	const { providers, isLoading, error } = useProviderListings()
	const { remoteConfigSettings } = useExtensionState()
	const allowed = (remoteConfigSettings as { remoteConfiguredProviders?: string[] } | undefined)?.remoteConfiguredProviders
	const [query, setQuery] = useState("")
	const [showAll, setShowAll] = useState(false)
	const [picked, setPicked] = useState<ProviderListing>()

	const all = useMemo(() => chooserProviders(providers, allowed), [providers, allowed])
	const filter = query.trim().toLowerCase()
	const hits = all.filter((provider) => !filter || provider.name.toLowerCase().includes(filter) || provider.id.includes(filter))
	const shown = filter || showAll ? hits : hits.slice(0, FIRST_PROVIDER_COUNT)

	return (
		<div className="mt-1.5 rounded-md border border-editor-group-border px-2.5 py-2" data-testid="provider-chooser">
			{picked ? (
				<ProviderSetup key={picked.id} listing={picked} onBack={() => setPicked(undefined)} onDone={onClose} />
			) : (
				<>
					<Input
						aria-label="Filter providers"
						autoComplete="off"
						autoFocus
						className="h-7 rounded-xs px-2 py-0 text-[12.5px] md:text-[12.5px]"
						onChange={(event) => setQuery(event.target.value)}
						placeholder={all.length ? `Filter ${all.length} providers` : "Filter providers"}
						spellCheck={false}
						value={query}
					/>
					{isLoading && !all.length && <Hint>Reading the catalog…</Hint>}
					{error && <Why tone="bad">Can't read the provider catalog: {error.message}</Why>}
					{allowed?.length ? <Hint>Your organization allows these providers.</Hint> : null}
					<div className="mt-1.5 flex flex-wrap gap-1">
						{shown.map((provider) => (
							<button
								className="h-[22px] cursor-pointer whitespace-nowrap rounded-full border border-solid border-editor-group-border bg-transparent px-2 text-[12px] text-description hover:text-foreground"
								key={provider.id}
								onClick={() => setPicked(provider)}
								type="button">
								{provider.name}
							</button>
						))}
						{!filter && !showAll && all.length > FIRST_PROVIDER_COUNT && (
							<button
								className="h-[22px] cursor-pointer whitespace-nowrap rounded-full border border-solid border-editor-group-border bg-transparent px-2 text-[12px] text-description hover:text-foreground"
								onClick={() => setShowAll(true)}
								type="button">
								{all.length - FIRST_PROVIDER_COUNT} more
							</button>
						)}
					</div>
					{filter && !hits.length && (
						<Hint>
							No provider called “{query.trim()}”. If it speaks the OpenAI API,{" "}
							<LinkButton onClick={onAddConnection}>add a connection</LinkButton> with its base URL.
						</Hint>
					)}
				</>
			)}
			{!picked && (
				<div className="mt-2">
					<ActionButton onClick={onClose}>Cancel</ActionButton>
				</div>
			)}
		</div>
	)
}
