import type { ApiProvider } from "@shared/api"
import { ALLOWED_API_PROVIDERS, type OpenAiCompatibleApiType } from "@shared/api-profiles"
import BedrockData from "@shared/providers/bedrock.json"
import { VSCodeButton, VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useProviderModels } from "@/hooks/useProviderModels"
import { ModelSelector } from "../common/ModelSelector"
import {
	API_TYPE_LABELS,
	changeDraftProvider,
	hasSavedSecret,
	PROVIDER_LABELS,
	type ProfileDraft,
	setDraftOption,
	setDraftSecret,
} from "./profileDraft"

interface ApiProfileEditorProps {
	draft: ProfileDraft
	onChange: (draft: ProfileDraft) => void
	/** Modes ("Ask"/"Act") currently using this configuration. */
	assignedModes: string[]
	isSaving?: boolean
	error?: string
	/** When omitted (e.g. onboarding) the back-to-list breadcrumb is hidden. */
	onBack?: () => void
	onSave: (draft: ProfileDraft) => void
	onDuplicate?: () => void
	onDelete?: () => void
}

const Label = ({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) => (
	<label className="block font-medium mb-1" htmlFor={htmlFor}>
		{children}
	</label>
)

const Hint = ({ children }: { children: React.ReactNode }) => (
	<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">{children}</p>
)

const SecretField = ({
	draft,
	secretKey,
	label,
	onChange,
}: {
	draft: ProfileDraft
	secretKey: string
	label: string
	onChange: (draft: ProfileDraft) => void
}) => {
	const saved = hasSavedSecret(draft, secretKey)
	return (
		<div>
			<VSCodeTextField
				data-testid={`secret-${secretKey}`}
				onInput={(e) => onChange(setDraftSecret(draft, secretKey, (e.target as HTMLInputElement).value))}
				placeholder={saved ? "•••••••• (saved, leave blank to keep)" : "Enter value..."}
				style={{ width: "100%" }}
				type="password"
				value={draft.secrets[secretKey] ?? ""}>
				<span className="font-medium">{label}</span>
			</VSCodeTextField>
		</div>
	)
}

const TextOption = ({
	draft,
	optionKey,
	label,
	placeholder,
	onChange,
}: {
	draft: ProfileDraft
	optionKey: string
	label: string
	placeholder?: string
	onChange: (draft: ProfileDraft) => void
}) => (
	<VSCodeTextField
		data-testid={`option-${optionKey}`}
		onInput={(e) => onChange(setDraftOption(draft, optionKey, (e.target as HTMLInputElement).value))}
		placeholder={placeholder}
		style={{ width: "100%" }}
		value={(draft.options[optionKey] as string | undefined) ?? ""}>
		<span className="font-medium">{label}</span>
	</VSCodeTextField>
)

const ModelField = ({ draft, onChange }: { draft: ProfileDraft; onChange: (draft: ProfileDraft) => void }) => {
	const { models } = useProviderModels(draft.provider)
	if (draft.provider === "openai") {
		return (
			<VSCodeTextField
				data-testid="model-id-input"
				onInput={(e) => onChange({ ...draft, modelId: (e.target as HTMLInputElement).value })}
				placeholder="Enter model ID..."
				style={{ width: "100%" }}
				value={draft.modelId}>
				<span className="font-medium">Model ID</span>
			</VSCodeTextField>
		)
	}
	return (
		<ModelSelector
			label="Model"
			models={models}
			onChange={(e) => onChange({ ...draft, modelId: e.target.value })}
			selectedModelId={draft.modelId}
		/>
	)
}

const ProviderFields = ({ draft, onChange }: { draft: ProfileDraft; onChange: (draft: ProfileDraft) => void }) => {
	switch (draft.provider) {
		case "openai":
			return (
				<>
					<TextOption
						draft={draft}
						label="Base URL"
						onChange={onChange}
						optionKey="openAiBaseUrl"
						placeholder="https://api.example.com/v1"
					/>
					<SecretField draft={draft} label="API Key" onChange={onChange} secretKey="openAiApiKey" />
					<div>
						<Label htmlFor="profile-api-type">API Type</Label>
						<VSCodeDropdown
							aria-label="API type"
							className="w-full"
							id="profile-api-type"
							onChange={(e) =>
								onChange({
									...draft,
									openAiCompatibleApiType: (e.target as HTMLSelectElement).value as OpenAiCompatibleApiType,
								})
							}
							value={draft.openAiCompatibleApiType}>
							<VSCodeOption value="chat">{API_TYPE_LABELS.chat} (GPT-5.3 to 5.5, local servers)</VSCodeOption>
							<VSCodeOption value="responses">{API_TYPE_LABELS.responses} (GPT-5.6 to 6.1)</VSCodeOption>
						</VSCodeDropdown>
					</div>
				</>
			)
		case "anthropic":
			return (
				<>
					<SecretField draft={draft} label="Anthropic API Key" onChange={onChange} secretKey="apiKey" />
					<TextOption
						draft={draft}
						label="Custom base URL"
						onChange={onChange}
						optionKey="anthropicBaseUrl"
						placeholder="Default: https://api.anthropic.com"
					/>
				</>
			)
		case "openai-native":
			return <SecretField draft={draft} label="OpenAI API Key" onChange={onChange} secretKey="openAiNativeApiKey" />
		case "bedrock": {
			const auth = (draft.options.awsAuthentication as string | undefined) ?? "credentials"
			return (
				<>
					<div>
						<Label htmlFor="profile-aws-region">AWS Region</Label>
						<VSCodeDropdown
							className="w-full"
							id="profile-aws-region"
							onChange={(e) => onChange(setDraftOption(draft, "awsRegion", (e.target as HTMLSelectElement).value))}
							value={(draft.options.awsRegion as string | undefined) ?? "us-east-1"}>
							{BedrockData.regions.map((region) => (
								<VSCodeOption key={region} value={region}>
									{region}
								</VSCodeOption>
							))}
						</VSCodeDropdown>
					</div>
					<div>
						<Label htmlFor="profile-aws-auth">Authentication</Label>
						<VSCodeDropdown
							className="w-full"
							id="profile-aws-auth"
							onChange={(e) =>
								onChange({
									...draft,
									options: {
										...draft.options,
										awsAuthentication: (e.target as HTMLSelectElement).value,
										awsUseProfile: (e.target as HTMLSelectElement).value === "profile",
									},
								})
							}
							value={auth}>
							<VSCodeOption value="credentials">AWS Credentials</VSCodeOption>
							<VSCodeOption value="profile">AWS Profile</VSCodeOption>
							<VSCodeOption value="apikey">API Key</VSCodeOption>
						</VSCodeDropdown>
					</div>
					{auth === "apikey" && (
						<SecretField draft={draft} label="Bedrock API Key" onChange={onChange} secretKey="awsBedrockApiKey" />
					)}
					{auth === "profile" && (
						<TextOption
							draft={draft}
							label="AWS Profile Name"
							onChange={onChange}
							optionKey="awsProfile"
							placeholder="default"
						/>
					)}
					{auth === "credentials" && (
						<>
							<SecretField draft={draft} label="AWS Access Key" onChange={onChange} secretKey="awsAccessKey" />
							<SecretField draft={draft} label="AWS Secret Key" onChange={onChange} secretKey="awsSecretKey" />
							<SecretField
								draft={draft}
								label="AWS Session Token"
								onChange={onChange}
								secretKey="awsSessionToken"
							/>
						</>
					)}
					<VSCodeCheckbox
						checked={draft.options.awsUseCrossRegionInference === true}
						onChange={(e: any) =>
							onChange(setDraftOption(draft, "awsUseCrossRegionInference", e.target.checked === true))
						}>
						Use cross-region inference
					</VSCodeCheckbox>
				</>
			)
		}
		default:
			return null
	}
}

const ApiProfileEditor = ({
	draft,
	onChange,
	assignedModes,
	isSaving,
	error,
	onBack,
	onSave,
	onDuplicate,
	onDelete,
}: ApiProfileEditorProps) => {
	const [touched, setTouched] = useState(false)
	const isAssigned = assignedModes.length > 0
	const isNew = !draft.id
	const nameMissing = !draft.name.trim()
	const modelMissing = !draft.modelId.trim()
	const canSave = !nameMissing && !modelMissing && !isSaving

	return (
		<div className="flex flex-col gap-3">
			{onBack && (
				<div className="flex items-center gap-1 text-sm">
					<VSCodeButton appearance="icon" aria-label="Back to configurations" onClick={onBack}>
						<span className="codicon codicon-arrow-left" />
					</VSCodeButton>
					<button
						className="bg-transparent border-0 p-0 cursor-pointer text-(--vscode-textLink-foreground) hover:underline"
						onClick={onBack}
						type="button">
						Configurations
					</button>
					<span className="text-(--vscode-descriptionForeground)">/</span>
					<b>{draft.name.trim() || (isNew ? "New configuration" : "Untitled")}</b>
				</div>
			)}

			<VSCodeTextField
				data-testid="profile-name"
				onInput={(e) => onChange({ ...draft, name: (e.target as HTMLInputElement).value })}
				placeholder="e.g. Fast coder"
				style={{ width: "100%" }}
				value={draft.name}>
				<span className="font-medium">Name</span>
			</VSCodeTextField>
			{touched && nameMissing && <p className="text-xs text-(--vscode-errorForeground)">Name is required.</p>}

			<div>
				<Label htmlFor="profile-provider">API Provider</Label>
				<VSCodeDropdown
					className="w-full"
					id="profile-provider"
					onChange={(e) => onChange(changeDraftProvider(draft, (e.target as HTMLSelectElement).value as ApiProvider))}
					value={draft.provider}>
					{ALLOWED_API_PROVIDERS.map((provider) => (
						<VSCodeOption key={provider} value={provider}>
							{PROVIDER_LABELS[provider] ?? provider}
						</VSCodeOption>
					))}
				</VSCodeDropdown>
			</div>

			<ProviderFields draft={draft} onChange={onChange} />
			<ModelField draft={draft} onChange={onChange} />
			{touched && modelMissing && <p className="text-xs text-(--vscode-errorForeground)">Choose a model.</p>}

			{error && <p className="text-xs text-(--vscode-errorForeground)">{error}</p>}

			<div className="flex items-center gap-2 mt-2">
				<VSCodeButton
					disabled={isSaving}
					onClick={() => {
						setTouched(true)
						if (canSave) {
							onSave(draft)
						}
					}}>
					{isNew ? "Create" : "Save"}
				</VSCodeButton>
				{!isNew && onDuplicate && (
					<VSCodeButton appearance="secondary" onClick={onDuplicate}>
						Duplicate
					</VSCodeButton>
				)}
				<span className="flex-1" />
				{!isNew && onDelete && (
					<VSCodeButton appearance="secondary" disabled={isAssigned} onClick={onDelete}>
						Delete
					</VSCodeButton>
				)}
			</div>
			{isAssigned && !isNew && <Hint>Used by {assignedModes.join(" + ")}. Assign another configuration to delete it.</Hint>}
		</div>
	)
}

export default ApiProfileEditor
