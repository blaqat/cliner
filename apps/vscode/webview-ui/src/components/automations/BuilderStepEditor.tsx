import { automationModelName, findAutomationModel } from "@shared/automation-models"
import {
	type AutomationDefinition,
	type AutomationOutput,
	type AutomationStep,
	type AutomationThreadSpec,
	automationThreads,
	automationWorkspace,
	blankThread,
	uniqueStepId,
} from "@shared/automations"
import { isThreadWorkspaceChoice } from "@shared/thread-worktrees"
import { useMemo, useRef, useState } from "react"
import { ModelPickButton } from "@/components/models/ModelPickButton"
import type { SelectorRow } from "@/components/models/ModelSelector"
import { selectorDataFromModelSettings } from "@/components/models/modelSelectorRows"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"

export const FIELD_CLASS =
	"w-full min-w-0 rounded-xs border border-input-border bg-input-background px-1.5 py-0.5 text-xs text-input-foreground outline-none placeholder:text-input-placeholder focus:border-(--vscode-focusBorder)"
const LABEL_CLASS = "mt-1.5 mb-0.5 block text-[11px] text-description"
const CHIP_CLASS =
	"cursor-pointer rounded-full border border-solid border-editor-group-border bg-transparent px-1.5 font-mono text-[10.5px] leading-4 text-foreground hover:bg-list-hover"

/** Placeholders a step may use: every argument and every step (or together thread) before it. */
export function placeholdersBefore(definition: AutomationDefinition, stepId: string): string[] {
	const index = definition.steps.findIndex((step) => step.id === stepId)
	const earlier = definition.steps.slice(0, Math.max(0, index))
	return [
		...definition.arguments.map((arg) => `{{${arg.name}}}`),
		...earlier.flatMap((step) =>
			step.kind === "task"
				? []
				: [`{{steps.${step.id}}}`, ...(step.kind === "together" ? step.threads.map((t) => `{{steps.${t.id}}}`) : [])],
		),
		...automationThreads(earlier).flatMap(({ thread }) =>
			(thread.outputs ?? []).filter(({ name }) => !!name).map(({ name }) => `{{steps.${thread.id}.${name}}}`),
		),
	]
}

/** A prompt with clickable placeholders under it; a click inserts at the cursor. */
export function PromptField({
	label,
	value,
	onChange,
	placeholders,
	placeholder,
	readOnly,
	rows = 4,
	testId,
}: {
	label: string
	value: string
	onChange: (next: string) => void
	placeholders: string[]
	placeholder?: string
	readOnly?: boolean
	rows?: number
	testId?: string
}) {
	const ref = useRef<HTMLTextAreaElement>(null)
	const insert = (token: string) => {
		const element = ref.current
		const start = element?.selectionStart ?? value.length
		const end = element?.selectionEnd ?? value.length
		onChange(`${value.slice(0, start)}${token}${value.slice(end)}`)
		requestAnimationFrame(() => {
			element?.focus()
			element?.setSelectionRange(start + token.length, start + token.length)
		})
	}
	return (
		<label className="block">
			<span className={LABEL_CLASS}>{label}</span>
			<textarea
				className={cn(FIELD_CLASS, "resize-y font-[inherit]")}
				data-testid={testId}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				readOnly={readOnly}
				ref={ref}
				rows={rows}
				value={value}
			/>
			{placeholders.length > 0 && (
				<span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-description">
					Insert
					{placeholders.map((token) => (
						<button className={CHIP_CLASS} key={token} onClick={() => insert(token)} type="button">
							{token}
						</button>
					))}
				</span>
			)}
		</label>
	)
}

const DEFAULT_ROW: SelectorRow = {
	id: "default",
	label: "Default model",
	detail: "The model Settings › Models uses for the step's mode",
	levels: null,
	noLevelsReason: "Uses the default model's level",
}

/** The step's model and level: the same picker as Settings, plus "Default model". Files store the model's name. */
function ModelField({
	thread,
	onChange,
}: {
	thread: AutomationThreadSpec
	onChange: (patch: Partial<AutomationThreadSpec>) => void
}) {
	const { modelSettings, navigateToSettings } = useExtensionState()
	const data = useMemo(() => (modelSettings ? selectorDataFromModelSettings(modelSettings) : undefined), [modelSettings])
	if (!modelSettings || !data) {
		return (
			<label className="block">
				<span className={LABEL_CLASS}>Model (its name, or leave empty for your current model)</span>
				<input
					className={FIELD_CLASS}
					onChange={(event) => onChange({ model: event.target.value })}
					placeholder="Default"
					value={thread.model}
				/>
			</label>
		)
	}
	const row = thread.model ? findAutomationModel(modelSettings, thread.model) : undefined
	const pick = !thread.model
		? { rowId: "default", levelId: "default" }
		: row
			? { rowId: row.id, levelId: thread.level || data.rows.find((r) => r.id === row.id)?.levels?.[0]?.id || "default" }
			: null
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="text-[11px] text-description">Model</span>
			<ModelPickButton
				ladder={data.ladder}
				modelsLabel="Step model"
				onCommit={(next) => {
					if (next.rowId === "default") return onChange({ model: "", level: "" })
					const chosen = modelSettings.settings.models.find((model) => model.id === next.rowId)
					if (!chosen) return
					const offersLevels = !!data.rows.find((candidate) => candidate.id === next.rowId)?.levels
					onChange({ model: automationModelName(chosen), level: offersLevels ? next.levelId : "" })
				}}
				onManage={(target) => navigateToSettings(target ?? "models")}
				pick={pick}
				rows={[DEFAULT_ROW, ...data.rows]}
			/>
			{thread.model && !row && <span className="text-[11px] text-error">{thread.model} isn't set up here</span>}
		</div>
	)
}

function ModeField({ mode, onChange }: { mode: "ask" | "act"; onChange: (mode: "ask" | "act") => void }) {
	return (
		<div aria-label="Mode" className="flex items-center gap-1.5" role="radiogroup">
			<span className="text-[11px] text-description">Mode</span>
			{(["ask", "act"] as const).map((value) => (
				<button
					aria-checked={mode === value}
					className={cn(
						"cursor-pointer rounded-xs border border-solid px-1.5 text-[11px] leading-4",
						mode === value
							? "border-(--vscode-focusBorder) bg-button-background text-button-foreground"
							: "border-editor-group-border bg-transparent text-foreground hover:bg-list-hover",
					)}
					key={value}
					onClick={() => onChange(value)}
					role="radio"
					type="button">
					{value === "ask" ? "Ask" : "Act"}
				</button>
			))}
			<span className="text-[11px] text-description">{mode === "act" ? "Edits files." : "Reads and answers."}</span>
		</div>
	)
}

function ThreadFields({
	thread,
	onChange,
	placeholders,
	promptLabel = "Prompt",
	promptPlaceholder,
}: {
	thread: AutomationThreadSpec
	onChange: (patch: Partial<AutomationThreadSpec>) => void
	placeholders: string[]
	promptLabel?: string
	promptPlaceholder?: string
}) {
	const scope = automationWorkspace(thread)
	return (
		<>
			<PromptField
				label={promptLabel}
				onChange={(prompt) => onChange({ prompt })}
				placeholder={promptPlaceholder}
				placeholders={placeholders}
				testId={`builder-prompt-${thread.id}`}
				value={thread.prompt}
			/>
			<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
				<ModelField onChange={onChange} thread={thread} />
				<ModeField mode={thread.mode} onChange={(mode) => onChange({ mode })} />
				<label className="flex items-center gap-1 text-[11px]">
					Run in
					<select
						className={cn(FIELD_CLASS, "w-auto")}
						onChange={(event) => {
							const value = event.target.value
							onChange({ worktree: false, worktreeScope: isThreadWorkspaceChoice(value) ? value : undefined })
						}}
						value={scope ?? "default"}>
						<option value="default">Follow the task</option>
						<option value="task">Task worktree</option>
						<option value="thread">Its own worktree</option>
						<option value="workspace">Your workspace</option>
					</select>
				</label>
			</div>
			{(scope === "task" || scope === "thread") && (
				<div className="mt-0.5 text-[11px] text-description">
					{scope === "task"
						? "Creates a worktree that threads in this task can share."
						: "Starts a separate worktree for this thread."}
				</div>
			)}
			<OutputFields onChange={(outputs) => onChange({ outputs })} thread={thread} />
		</>
	)
}

function OutputFields({ thread, onChange }: { thread: AutomationThreadSpec; onChange: (outputs: AutomationOutput[]) => void }) {
	const outputs = thread.outputs ?? []
	const update = (index: number, patch: Partial<AutomationOutput>) =>
		onChange(outputs.map((output, i) => (i === index ? { ...output, ...patch } : output)))
	return (
		<div className="mt-2">
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] text-description">Outputs</span>
				<button
					className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
					onClick={() => onChange([...outputs, { name: "", description: "" }])}
					type="button">
					Add output
				</button>
			</div>
			{outputs.map((output, index) => (
				<div className="mt-1.5 rounded-xs border border-editor-group-border p-1.5" key={index}>
					<div className="flex items-center gap-1.5">
						<input
							aria-label="Output name"
							className={cn(FIELD_CLASS, "font-mono")}
							onChange={(event) => update(index, { name: event.target.value })}
							placeholder="e.g. findings"
							value={output.name}
						/>
						<button
							aria-label={`Remove output ${output.name || index + 1}`}
							className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent text-description hover:bg-list-hover hover:text-foreground"
							onClick={() => onChange(outputs.filter((_, i) => i !== index))}
							type="button">
							<span aria-hidden className="codicon codicon-close text-[12px]" />
						</button>
					</div>
					<input
						aria-label="Output description"
						className={cn(FIELD_CLASS, "mt-1")}
						onChange={(event) => update(index, { description: event.target.value })}
						placeholder="What should the thread record?"
						value={output.description}
					/>
					<label className="mt-1 flex items-center gap-1 text-[11px]">
						<input
							checked={!!output.saveAsNote}
							onChange={(event) => update(index, { saveAsNote: event.target.checked })}
							type="checkbox"
						/>
						Also save as a task note
					</label>
					{output.name && (
						<code className="block break-all text-[10.5px] text-description">{`{{steps.${thread.id}.${output.name}}}`}</code>
					)}
				</div>
			))}
		</div>
	)
}

/** Comma-separated choices, kept as typed until the field loses focus. */
function ChoicesInput({ value, onChange }: { value: string[]; onChange: (choices: string[]) => void }) {
	const [text, setText] = useState(value.join(", "))
	return (
		<input
			className={FIELD_CLASS}
			onBlur={() =>
				onChange(
					text
						.split(",")
						.map((choice) => choice.trim())
						.filter(Boolean),
				)
			}
			onChange={(event) => setText(event.target.value)}
			placeholder="Ship it, Try again"
			value={text}
		/>
	)
}

/** The open step's editor, by kind. */
export function BuilderStepEditor({
	definition,
	step,
	onChange,
}: {
	definition: AutomationDefinition
	step: AutomationStep
	onChange: (next: AutomationStep) => void
}) {
	const placeholders = placeholdersBefore(definition, step.id)
	const titleField = (
		<label className="block">
			<span className={LABEL_CLASS}>{step.kind === "task" ? "Step name" : "Title"}</span>
			<input
				className={FIELD_CLASS}
				data-testid={`builder-title-${step.id}`}
				onChange={(event) => onChange({ ...step, title: event.target.value })}
				value={step.title}
			/>
		</label>
	)
	switch (step.kind) {
		case "task":
			return (
				<div>
					{titleField}
					<label className="block">
						<span className={LABEL_CLASS}>Find the task tagged with this ticket, or make one</span>
						<input
							className={FIELD_CLASS}
							onChange={(event) => onChange({ ...step, ticket: event.target.value })}
							value={step.ticket}
						/>
					</label>
					<label className="block">
						<span className={LABEL_CLASS}>Title for a new task (empty uses the ticket)</span>
						<input
							className={FIELD_CLASS}
							onChange={(event) => onChange({ ...step, newTaskTitle: event.target.value })}
							value={step.newTaskTitle}
						/>
					</label>
				</div>
			)
		case "thread":
			return (
				<div>
					{titleField}
					<ThreadFields
						onChange={(patch) => onChange({ ...step, ...patch })}
						placeholders={placeholders}
						promptPlaceholder="What this thread should do. End with what its reply should contain."
						thread={step}
					/>
				</div>
			)
		case "together":
			return (
				<div>
					{titleField}
					<PromptField
						label="Prompt for every thread (a thread can have its own instead)"
						onChange={(prompt) => onChange({ ...step, prompt })}
						placeholder="e.g. Review the change and list risks on their lines."
						placeholders={placeholders}
						testId={`builder-prompt-${step.id}`}
						value={step.prompt}
					/>
					{step.threads.map((thread, index) => (
						<div className="mt-2 rounded-xs border border-editor-group-border px-2 pb-1.5" key={thread.id}>
							<div className="flex items-center gap-1.5">
								<input
									aria-label={`Thread ${index + 1} title`}
									className={cn(FIELD_CLASS, "mt-1.5")}
									onChange={(event) =>
										onChange({
											...step,
											threads: step.threads.map((t, i) =>
												i === index ? { ...t, title: event.target.value } : t,
											),
										})
									}
									value={thread.title}
								/>
								<button
									aria-label={`Remove ${thread.title || "thread"}`}
									className="mt-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-list-hover hover:text-foreground disabled:cursor-default disabled:opacity-40"
									disabled={step.threads.length <= 2}
									onClick={() => onChange({ ...step, threads: step.threads.filter((_, i) => i !== index) })}
									title={step.threads.length <= 2 ? "Together needs at least 2 threads" : "Remove"}
									type="button">
									<span aria-hidden className="codicon codicon-close text-[12px]" />
								</button>
							</div>
							<ThreadFields
								onChange={(patch) =>
									onChange({
										...step,
										threads: step.threads.map((t, i) => (i === index ? { ...t, ...patch } : t)),
									})
								}
								placeholders={placeholders}
								promptLabel="Its own prompt (empty uses the one above)"
								thread={thread}
							/>
						</div>
					))}
					<button
						className="mt-1.5 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
						onClick={() => {
							const id = uniqueStepId(
								`${step.id}-${String.fromCharCode(97 + step.threads.length)}`,
								definition.steps,
							)
							onChange({
								...step,
								threads: [...step.threads, blankThread(id, `Thread ${step.threads.length + 1}`)],
							})
						}}
						type="button">
						＋ Thread
					</button>
				</div>
			)
		case "checkpoint": {
			const groups = definition.steps
				.slice(
					0,
					definition.steps.findIndex((candidate) => candidate.id === step.id),
				)
				.filter((candidate) => candidate.kind === "together")
			return (
				<div>
					{titleField}
					<PromptField
						label="What to ask you"
						onChange={(question) => onChange({ ...step, question })}
						placeholders={placeholders}
						rows={2}
						value={step.question}
					/>
					<label className="block">
						<span className={LABEL_CLASS}>Choices</span>
						<select
							className={FIELD_CLASS}
							onChange={(event) => onChange({ ...step, choicesFrom: event.target.value })}
							value={step.choicesFrom}>
							<option value="">Fixed choices (or just Continue)</option>
							{groups.map((group) => (
								<option key={group.id} value={group.id}>
									Pick one of the threads in “{group.title}”
								</option>
							))}
						</select>
					</label>
					{groups.length === 0 && (
						<div className="mt-0.5 text-[11px] text-description">
							Add a Threads together step before this one to pick between its threads.
						</div>
					)}
					{!step.choicesFrom && (
						<label className="block">
							<span className={LABEL_CLASS}>Fixed choices, separated by commas (empty shows Continue)</span>
							<ChoicesInput onChange={(choices) => onChange({ ...step, choices })} value={step.choices} />
						</label>
					)}
					<div className="mt-1 text-[11px] text-description">
						Later steps get the pick with {`{{steps.${step.id}}}`}: the picked thread's reply, or the choice's name.
					</div>
				</div>
			)
		}
	}
}
