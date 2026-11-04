import type { Connection, Knowledge, ModelLevel, ModelValues } from "@shared/model-settings"
import { useState } from "react"
import {
	CommitInput,
	ControlRow,
	Field,
	FieldGrid,
	FoldHeader,
	Hint,
	KNOWLEDGE_OPTIONS,
	parseAmount,
	parseTokens,
	Segmented,
	Why,
} from "./fields"
import { useModelsPage } from "./modelsPageContext"
import { DEFAULT_OFFERED, levelTitle, STANDARD_LADDER, sharedDefaultsPatch, sharedSummary } from "./modelsView"

/**
 * A connection's defaults: models use these for anything they don't know themselves. They live on the
 * connection, so a change reaches every model that didn't set its own, including ones already added.
 */
export const SharedDefaults = ({ connection, startOpen }: { connection: Connection; startOpen?: boolean }) => {
	const { store } = useModelsPage()
	const [open, setOpen] = useState(!!startOpen)
	const [error, setError] = useState<string>()
	const defaults = connection.defaults

	const save = async (change: Partial<ModelValues>) => {
		const outcome = await store.saveConnection(sharedDefaultsPatch(connection.id, change))
		setError(outcome.ok ? undefined : outcome.message)
		return outcome.ok ? undefined : outcome.message
	}

	const numberField = (key: "contextWindow" | "maxOutputTokens", label: string) => (
		<Field label={label}>
			<CommitInput
				label={`Shared ${label}`}
				mono
				onCommit={(text) => {
					const parsed = parseTokens(text)
					return "error" in parsed ? parsed.error : save({ [key]: parsed.value })
				}}
				placeholder="unknown"
				unknown
				value={defaults[key] == null ? "" : String(defaults[key])}
			/>
		</Field>
	)

	const amountField = (key: "temperature" | "inputPrice" | "outputPrice", label: string, placeholder = "unknown") => (
		<Field label={label}>
			<CommitInput
				label={`Shared ${label}`}
				mono
				onCommit={(text) => {
					const parsed = parseAmount(text)
					return "error" in parsed ? parsed.error : save({ [key]: parsed.value })
				}}
				placeholder={placeholder}
				unknown={placeholder === "unknown"}
				value={defaults[key] == null ? "" : String(defaults[key])}
			/>
		</Field>
	)

	const knowledge = (key: "images" | "tools" | "reasoning", label: string) => (
		<ControlRow label={label}>
			<Segmented<Knowledge>
				label={`Shared ${label}`}
				onChange={(value) => {
					if (key === "reasoning" && value === "yes" && !defaults.levels) {
						void save({ reasoning: value, levels: DEFAULT_OFFERED })
					} else {
						void save({ [key]: value })
					}
				}}
				options={KNOWLEDGE_OPTIONS}
				value={defaults[key] ?? "unknown"}
			/>
		</ControlRow>
	)

	const levels: ModelLevel[] = defaults.levels ?? DEFAULT_OFFERED
	const toggleLevel = (level: ModelLevel) => {
		const on = levels.some((candidate) => candidate.id === level.id)
		void save({
			levels: on
				? levels.filter((candidate) => candidate.id !== level.id)
				: [...levels, level].sort((a, b) => a.rank - b.rank),
		})
	}

	return (
		<div data-testid={`shared-defaults-${connection.id}`}>
			<FoldHeader
				onToggle={() => setOpen((current) => !current)}
				open={open}
				summary={sharedSummary(defaults)}
				title="Shared defaults"
			/>
			{open && (
				<div className="mb-1.5 rounded-[5px] border border-editor-group-border px-2 pb-2">
					<FieldGrid>
						{numberField("contextWindow", "Context window")}
						{numberField("maxOutputTokens", "Max output tokens")}
					</FieldGrid>
					{knowledge("reasoning", "Reasoning")}
					{defaults.reasoning === "yes" && (
						<div className="mb-1 flex flex-wrap gap-1">
							{STANDARD_LADDER.filter((level) => level.id !== "default").map((level) => {
								const on = levels.some((candidate) => candidate.id === level.id)
								return (
									<button
										aria-checked={on}
										className={`h-[22px] cursor-pointer rounded-full border border-solid border-editor-group-border px-2 text-[12px] ${on ? "bg-selection text-selection-foreground" : "bg-transparent text-description"}`}
										key={level.id}
										onClick={() => toggleLevel(level)}
										role="checkbox"
										type="button">
										{levelTitle(level.label)}
									</button>
								)
							})}
						</div>
					)}
					<FieldGrid className="mt-0.5">{amountField("temperature", "Temperature", "Not sent")}</FieldGrid>
					<FieldGrid className="mt-0.5">
						{amountField("inputPrice", "Input, per 1M")}
						{amountField("outputPrice", "Output, per 1M")}
					</FieldGrid>
					<Hint>
						A model uses these for anything it doesn't know itself. A value set on a model wins. Change one here and
						every model that didn't set its own follows.
					</Hint>
					{error && <Why tone="bad">{error}</Why>}
				</div>
			)}
		</div>
	)
}
