import type { ModelValues } from "@shared/model-settings"
import { ResolveProviderModelsRequest } from "@shared/proto/cline/models"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"
import { Hint, Why } from "./fields"
import { DEFAULT_OFFERED } from "./modelsView"

/** Catalogs a compatible server's model is most often a copy of. */
const PRESET_PROVIDERS = ["openai-native", "anthropic", "gemini"]
const PRESET_LIMIT = 12

interface Preset {
	id: string
	name: string
	values: Partial<ModelValues>
}

/** Maintained catalog facts only. Prices are left out on purpose: only you know your rates. */
const fromCatalog = (
	id: string,
	info: {
		name?: string
		contextWindow?: number
		maxTokens?: number
		supportsImages?: boolean
		supportsPromptCache?: boolean
		thinkingConfig?: unknown
		supportsReasoning?: boolean
	},
): Preset => ({
	id,
	name: info.name || id,
	values: {
		...(info.contextWindow ? { contextWindow: info.contextWindow } : {}),
		...(info.maxTokens ? { maxOutputTokens: info.maxTokens } : {}),
		...(info.supportsImages !== undefined ? { images: info.supportsImages ? "yes" : "no" } : {}),
		...(info.supportsPromptCache !== undefined ? { promptCache: info.supportsPromptCache ? "yes" : "no" } : {}),
		...(info.supportsReasoning || info.thinkingConfig ? { reasoning: "yes", levels: DEFAULT_OFFERED } : {}),
	},
})

/** Starting points from the maintained catalog. Fills what isn't set on this model; never prices, never a value you set. */
export const ModelCatalogPresets = ({ onApply }: { onApply: (values: Partial<ModelValues>) => void }) => {
	const [presets, setPresets] = useState<Preset[]>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		let current = true
		void Promise.all(
			PRESET_PROVIDERS.map((providerId) =>
				ModelsServiceClient.resolveProviderModels(
					ResolveProviderModelsRequest.create({ providerId, forceRefresh: false }),
				).then(
					(response) =>
						Object.entries(response.models ?? {})
							.slice(0, PRESET_LIMIT / PRESET_PROVIDERS.length)
							.map(([id, info]) => fromCatalog(id, info as never)),
					() => [] as Preset[],
				),
			),
		)
			.then((lists) => current && setPresets(lists.flat()))
			.catch((caught) => current && setError(caught instanceof Error ? caught.message : String(caught)))
		return () => {
			current = false
		}
	}, [])

	if (error) {
		return <Why tone="bad">{error}</Why>
	}
	if (!presets) {
		return <Hint>Reading the catalog…</Hint>
	}
	if (!presets.length) {
		return <Hint>The catalog has nothing to start from right now. Detect, or fill in what you know.</Hint>
	}
	return (
		<>
			<div className="mt-1.5 flex flex-wrap gap-1" data-testid="model-presets">
				{presets.map((preset) => (
					<button
						className="h-[22px] cursor-pointer whitespace-nowrap rounded-full border border-solid border-editor-group-border bg-transparent px-2 text-[12px] text-description hover:text-foreground"
						key={preset.id}
						onClick={() => onApply(preset.values)}
						type="button">
						{preset.name}
					</button>
				))}
			</div>
			<Hint>Presets never fill in prices. Only you know your rates.</Hint>
		</>
	)
}
