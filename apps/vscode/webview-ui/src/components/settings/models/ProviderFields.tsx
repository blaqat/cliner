import { BASE_URL_NEEDED, type ProviderConnection } from "@shared/model-settings"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { settingsConnectionElementId } from "../settingsTargets"
import { SecretField } from "./ConnectionForm"
import { CommitInput, ControlRow, Field, FieldGrid, Hint, LockedIcon, SmallSwitch } from "./fields"
import { useModelsPage } from "./modelsPageContext"
import { isValidUrl, secretField, secretRef } from "./modelsView"
import { isFieldVisible, type ProviderField, type ProviderSpec } from "./providerSpecs"

type Values = Record<string, unknown>

const REQUIRED_SECRET_NOTE = "Required. Type a new one to replace it."

/**
 * One provider field. A dropdown, a switch or a text box, with its Remote Config lock in the row.
 * Values and locks are read and written through props, so connection options and model options share it.
 */
export const ProviderFieldControl = ({
	field,
	value,
	onChange,
	locked,
	error,
	id,
}: {
	field: ProviderField
	value: unknown
	onChange: (value: unknown) => Promise<string | undefined> | string | undefined | void
	locked: boolean
	error?: string
	id?: string
}) => {
	const { organization } = useModelsPage()
	const lock = locked ? <LockedIcon title={`${organization} manages this. Ask your admin to change it.`} /> : null
	if (field.type === "toggle") {
		return (
			<ControlRow description={field.hint} label={field.label} tag={lock}>
				<SmallSwitch
					checked={value === true}
					disabled={locked}
					id={id}
					label={field.label}
					onChange={(checked) => void onChange(checked)}
				/>
			</ControlRow>
		)
	}
	if (field.type === "select") {
		return (
			<Field error={error} hint={field.hint} label={field.label} tag={lock}>
				<Select
					disabled={locked}
					onValueChange={(next) => void onChange(next)}
					value={typeof value === "string" ? value : undefined}>
					<SelectTrigger
						aria-label={field.label}
						className="w-full rounded-xs px-[7px] py-0 text-[12.5px] data-[size=default]:h-6"
						id={id}>
						<SelectValue placeholder="Choose" />
					</SelectTrigger>
					<SelectContent>
						{field.choices?.map((choice) => (
							<SelectItem key={choice.value} value={choice.value}>
								{choice.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
		)
	}
	if (field.type === "selector") {
		const selector = (value ?? {}) as Record<string, string>
		const set = (key: string, text: string) => {
			const { [key]: _old, ...rest } = selector
			return onChange(text.trim() ? { ...rest, [key]: text.trim() } : rest)
		}
		return (
			<>
				<Field hint="As VS Code names it." label={`${field.label}: vendor`} tag={lock}>
					<CommitInput
						disabled={locked}
						id={id}
						label="Vendor"
						mono
						onCommit={(text) => set("vendor", text)}
						placeholder="copilot"
						value={selector.vendor ?? ""}
					/>
				</Field>
				<Field label={`${field.label}: family`}>
					<CommitInput
						disabled={locked}
						label="Family"
						mono
						onCommit={(text) => set("family", text)}
						placeholder="Default"
						value={selector.family ?? ""}
					/>
				</Field>
			</>
		)
	}
	return (
		<Field error={error} hint={field.hint} label={field.label} tag={lock}>
			<CommitInput
				disabled={locked}
				id={id}
				label={field.label}
				mono
				onCommit={(text) => onChange(text.trim())}
				placeholder={field.placeholder}
				value={typeof value === "string" ? value : value == null ? "" : String(value)}
			/>
		</Field>
	)
}

const isUrlField = (field: ProviderField) => field.slot === "base-url" || /url$/i.test(field.id)

/** Everything a connection to this provider can set, kept reachable under that connection. */
export const ProviderConnectionFields = ({
	connection,
	spec,
	onError,
}: {
	connection: ProviderConnection
	spec: ProviderSpec
	onError: (message: string | undefined) => void
}) => {
	const { store, managedKey } = useModelsPage()
	const anchor = `${settingsConnectionElementId(connection.id)}-control`
	const options = connection.options as Values

	const save = async (
		patch: Parameters<typeof store.saveConnection>[0],
		secrets?: Parameters<typeof store.saveConnection>[1],
	) => {
		const outcome = await store.saveConnection(patch, secrets)
		onError(outcome.ok ? undefined : outcome.message)
		return outcome.ok ? undefined : outcome.message
	}

	const saveField = (field: ProviderField, value: unknown) => {
		if (typeof value === "string" && value && isUrlField(field) && !isValidUrl(value)) {
			return "That isn't a URL. It starts with http:// or https://."
		}
		if (field.slot === "base-url") {
			return save({ id: connection.id, baseUrl: (value as string) || null })
		}
		// A URL also set on the connection itself wins over the option, so keep the two together.
		const alsoBase = isUrlField(field) && connection.baseUrl !== null ? { baseUrl: (value as string) || null } : {}
		const change = value === "" ? { remove: { options: [field.id] } } : { options: { [field.id]: value } }
		return save({ id: connection.id, ...alsoBase, ...change } as Parameters<typeof store.saveConnection>[0])
	}

	const key = spec.auth === "keychain" || spec.auth === "optional-key"
	// A connection that moved over keeps its key under its old field name.
	const keyRef = connection.auth.kind === "keychain" ? connection.auth.secretRef : secretRef(connection.id, "apiKey")
	const keyField = secretField(keyRef)
	const firstField = spec.fields.find((field) => isFieldVisible(field, options))
	// A flagged URL is the one thing to fix here, so the connection's fix link lands on it.
	const flaggedUrl =
		connection.baseUrl === BASE_URL_NEEDED
			? spec.fields.find((field) => isUrlField(field) && isFieldVisible(field, options))
			: undefined
	const anchorField = flaggedUrl ?? (key ? undefined : firstField)

	return (
		<FieldGrid>
			{key && (
				<Field
					label={spec.auth === "optional-key" ? "API key (optional)" : "API key"}
					tag={managedKey("apiKey") ? <LockedIcon title="Managed" /> : undefined}>
					<SecretField
						configured={!!store.state?.configuredSecrets[keyRef]}
						disabled={managedKey("apiKey")}
						id={anchorField ? undefined : anchor}
						label="API key"
						onRemove={
							spec.auth === "optional-key"
								? () =>
										save({ id: connection.id, auth: { kind: "none" } }, [
											{ field: keyField, operation: "delete" },
										])
								: undefined
						}
						onSet={(value) =>
							save({ id: connection.id, auth: { kind: "keychain", secretRef: keyRef } }, [
								{ field: keyField, operation: "set", value },
							])
						}
						placeholder="Paste key"
						requiredNote={spec.auth === "optional-key" ? undefined : REQUIRED_SECRET_NOTE}
					/>
				</Field>
			)}
			{spec.fields
				.filter((field) => isFieldVisible(field, options))
				.map((field) => {
					const controlId = field === anchorField ? anchor : undefined
					if (field.slot === "secret") {
						const ref = connection.secretRefs[field.id] ?? secretRef(connection.id, field.id)
						return (
							<Field key={field.id} label={field.label}>
								<SecretField
									configured={!!store.state?.configuredSecrets[ref]}
									disabled={managedKey(field.id)}
									id={controlId}
									label={field.label}
									onRemove={
										field.required
											? undefined
											: () =>
													save({ id: connection.id, remove: { secretRefs: [field.id] } }, [
														{ field: field.id, operation: "delete" },
													])
									}
									onSet={(value) =>
										save({ id: connection.id, secretRefs: { [field.id]: ref } }, [
											{ field: field.id, operation: "set", value },
										])
									}
									placeholder="Paste value"
									requiredNote={field.required ? REQUIRED_SECRET_NOTE : undefined}
								/>
							</Field>
						)
					}
					const value =
						field.slot === "base-url"
							? connection.baseUrl
							: (options[field.id] ?? (isUrlField(field) ? connection.baseUrl : undefined))
					return (
						<ProviderFieldControl
							field={field}
							id={controlId}
							key={field.id}
							locked={managedKey(field.id)}
							onChange={(next) => saveField(field, next)}
							value={value}
						/>
					)
				})}
			{!key && !spec.fields.length && <Hint>{spec.note ?? "Nothing to set here."}</Hint>}
		</FieldGrid>
	)
}
