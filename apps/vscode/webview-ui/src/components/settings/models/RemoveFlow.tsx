import type { ModelSettingsState } from "@shared/model-settings-state"
import { useState } from "react"
import { ActionButton, SmallButton, Why } from "./fields"
import { useModelsPage } from "./modelsPageContext"
import { listWords, usedBy } from "./modelsView"
import type { Outcome } from "./useModelsStore"

/** Removing, in place and with no modal: one confirmation that says what else goes, then it's done. */
export const RemoveFlow = ({
	label,
	question,
	onRemove,
	onRemoved,
	modelIds = [],
}: {
	label: string
	question: string
	onRemove: () => Promise<Outcome<ModelSettingsState>>
	onRemoved: () => void
	/** The models this removes, to say what was using them. */
	modelIds?: string[]
}) => {
	const { store } = useModelsPage()
	const [confirming, setConfirming] = useState(false)
	const [savedThreads, setSavedThreads] = useState(0)
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)

	const begin = async () => {
		setConfirming(true)
		setError(undefined)
		if (modelIds.length) {
			const usage = await store.savedThreadUsage(modelIds)
			setSavedThreads(usage.ok ? usage.value.savedThreads : 0)
		}
	}

	const remove = async () => {
		setBusy(true)
		setError(undefined)
		const outcome = await onRemove()
		setBusy(false)
		if (!outcome.ok) {
			setError(outcome.message)
			return
		}
		onRemoved()
	}

	if (!confirming) {
		return (
			<ActionButton danger icon="trash" onClick={() => void begin()}>
				{label}
			</ActionButton>
		)
	}

	const settings = store.state?.settings
	const used = settings ? usedBy(settings, modelIds) : []
	return (
		<div
			className="grid basis-full gap-1.5 rounded-md border border-error/35 bg-error/10 px-2.5 py-2 text-[12.5px]"
			data-testid="remove-flow">
			<span>{question}</span>
			{used.length > 0 && <span className="text-description">Also clears it from {listWords(used)}.</span>}
			{savedThreads > 0 && (
				<span className="text-description">
					{savedThreads === 1 ? "1 saved thread" : `${savedThreads} saved threads`} will ask for a new model.
				</span>
			)}
			{error && <Why tone="bad">{error}</Why>}
			<div className="mt-0.5 flex flex-wrap items-center justify-end gap-1.5">
				<ActionButton onClick={() => setConfirming(false)}>Cancel</ActionButton>
				<SmallButton danger disabled={busy} onClick={() => void remove()}>
					Remove
				</SmallButton>
			</div>
		</div>
	)
}
