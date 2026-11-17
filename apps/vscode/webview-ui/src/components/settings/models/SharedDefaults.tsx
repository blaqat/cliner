import type { Connection, Knowledge, ModelLevel, ModelValues } from "@shared/model-settings"
import { useState } from "react"
import {
	CAPABILITY_OPTIONS,
	Chevron,
	CommitInput,
	ControlRow,
	Field,
	FieldGrid,
	GroupHeading,
	Icon,
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
				value={defaults[key] == null ? "" : String(defaults[key])}
			/>
		</Field>
	)

	const amountInput = (
		key: "temperature" | "inputPrice" | "outputPrice",
		label: string,
		placeholder: string,
		className?: string,
	) => (
		<CommitInput
			className={className}
			label={`Shared ${label}`}
			mono
			onCommit={(text) => {
				const parsed = parseAmount(text)
				return "error" in parsed ? parsed.error : save({ [key]: parsed.value })
			}}
			placeholder={placeholder}
			value={defaults[key] == null ? "" : String(defaults[key])}
		/>
	)

	const capability = (key: "images" | "tools", label: string) => (
		<ControlRow label={label}>
			<Segmented<"yes" | "no">
				label={`Shared ${label}`}
				onChange={(value) => void save({ [key]: value === "yes" ? "yes" : "unknown" })}
				options={CAPABILITY_OPTIONS}
				value={defaults[key] === "yes" ? "yes" : "no"}
			/>
		</ControlRow>
	)

	const knowledge = (key: "reasoning", label: string) => (
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
		<div
			className="mt-3 rounded-md border border-editor-group-border bg-(--vscode-sideBar-background)"
			data-testid={`shared-defaults-${connection.id}`}>
			<button
				aria-expanded={open}
				className="flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
				onClick={() => setOpen((current) => !current)}
				type="button">
				<Chevron open={open} />
				<Icon className="text-description" name="settings" />
				<span className="shrink-0 text-[13px]">Shared defaults</span>
				<span className="ml-auto min-w-0 truncate text-[12px] text-description">{sharedSummary(defaults)}</span>
			</button>
			{open && (
				<div className="border-t border-editor-group-border px-2.5 pb-3">
					<div className="mt-2">{knowledge("reasoning", "Reasoning")}</div>
					{defaults.reasoning === "yes" && (
						<div className="mb-1 flex flex-wrap gap-1">
							{STANDARD_LADDER.filter((level) => level.id !== "default").map((level) => {
								const on = levels.some((candidate) => candidate.id === level.id)
								return (
									<button
										aria-checked={on}
										className={`m-0 h-[22px] cursor-pointer rounded-full border border-solid border-editor-group-border px-2 text-[12px] ${on ? "bg-selection text-selection-foreground" : "bg-transparent text-description"}`}
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
					<GroupHeading>Price and limits</GroupHeading>
					<FieldGrid className="mt-0.5">
						<Field label="Input $/1M">{amountInput("inputPrice", "Input", "unknown")}</Field>
						<Field label="Output $/1M">{amountInput("outputPrice", "Output", "unknown")}</Field>
						{numberField("contextWindow", "Context window")}
						{numberField("maxOutputTokens", "Max output tokens")}
					</FieldGrid>
					<GroupHeading>More</GroupHeading>
					<div>
						<ControlRow label="Temperature">
							{amountInput("temperature", "Temperature", "Not sent", "w-[96px] text-right")}
						</ControlRow>
						{capability("tools", "Can use tools")}
						{capability("images", "Can see images")}
					</div>
					{error && <Why tone="bad">{error}</Why>}
				</div>
			)}
		</div>
	)
}
