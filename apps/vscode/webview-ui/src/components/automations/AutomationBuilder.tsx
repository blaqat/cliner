import {
	AUTOMATION_ARG_KINDS,
	AUTOMATION_STEP_LABELS,
	type AutomationArgument,
	type AutomationDefinition,
	type AutomationStep,
	type AutomationStepKind,
	automationDisplayName,
	blankStep,
	emptyAutomation,
	validateAutomation,
} from "@shared/automations"
import { SaveAutomationRequest } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import { useEffect, useMemo, useState } from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { Button } from "@/components/ui/button"
import { applyAutomationList, useAutomations } from "@/hooks/useAutomations"
import { cn } from "@/lib/utils"
import { AutomationServiceClient, FileServiceClient } from "@/services/grpc-client"
import { AutomationPromptEdit } from "./AutomationPromptEdit"
import { stepSummary } from "./automationSummary"
import { BuilderStepEditor, FIELD_CLASS, PromptField } from "./BuilderStepEditor"
import { type AutomationBuilderTarget, closeAutomationBuilder } from "./builderNavigation"

const SECTION_CLASS = "mt-3 mb-1 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-description"
const LABEL_CLASS = "mt-1.5 mb-0.5 block text-[11px] text-description"
const ADD_KINDS: AutomationStepKind[] = ["thread", "together", "checkpoint", "task"]

function stepLine(step: AutomationStep): string {
	const thread = (model: string, mode: string, worktree: boolean) =>
		[model || "Default model", mode === "act" ? "Act" : "Ask", worktree ? "new worktree" : ""].filter(Boolean).join(" · ")
	switch (step.kind) {
		case "task":
			return `Finds or opens the task for ${step.ticket || "a ticket"}`
		case "thread":
			return thread(step.model, step.mode, step.worktree)
		case "together":
			return step.threads.map((t) => `${t.title || t.id}: ${t.model || "Default"}`).join(" · ")
		case "checkpoint":
			return step.choicesFrom
				? `You pick one of “${step.choicesFrom}”`
				: step.choices.length
					? step.choices.join(" / ")
					: "You continue"
	}
}

function ArgumentRow({
	arg,
	onChange,
	onRemove,
}: {
	arg: AutomationArgument
	onChange: (next: AutomationArgument) => void
	onRemove: () => void
}) {
	const [choices, setChoices] = useState((arg.choices ?? []).join(", "))
	return (
		<div
			className="mb-1.5 rounded-xs border border-editor-group-border px-2 py-1.5"
			data-testid={`builder-arg-${arg.name || "new"}`}>
			<div className="flex items-center gap-1.5">
				<input
					aria-label="Argument name"
					className={cn(FIELD_CLASS, "min-w-0 flex-1 font-mono")}
					onChange={(event) => onChange({ ...arg, name: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })}
					placeholder="ticket"
					value={arg.name}
				/>
				<select
					aria-label="Kind"
					className={cn(FIELD_CLASS, "w-auto shrink-0")}
					onChange={(event) => onChange({ ...arg, kind: event.target.value as AutomationArgument["kind"] })}
					value={arg.kind}>
					{AUTOMATION_ARG_KINDS.map((kind) => (
						<option key={kind} value={kind}>
							{kind}
						</option>
					))}
				</select>
				<label className="flex shrink-0 items-center gap-1 text-[11px]">
					<input
						checked={arg.required}
						onChange={(event) => onChange({ ...arg, required: event.target.checked })}
						type="checkbox"
					/>
					Required
				</label>
				<button
					aria-label={`Remove ${arg.name || "argument"}`}
					className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-list-hover hover:text-foreground"
					onClick={onRemove}
					type="button">
					<span aria-hidden className="codicon codicon-close text-[12px]" />
				</button>
			</div>
			<input
				aria-label="What it is"
				className={cn(FIELD_CLASS, "mt-1")}
				onChange={(event) => onChange({ ...arg, description: event.target.value })}
				placeholder="What it is (shown in the start form)"
				value={arg.description}
			/>
			<div className="mt-1 flex items-center gap-1.5">
				{arg.kind === "choice" && (
					<input
						aria-label="Choices"
						className={FIELD_CLASS}
						onBlur={() =>
							onChange({
								...arg,
								choices: choices
									.split(",")
									.map((choice) => choice.trim())
									.filter(Boolean),
							})
						}
						onChange={(event) => setChoices(event.target.value)}
						placeholder="Choices, separated by commas"
						value={choices}
					/>
				)}
				<input
					aria-label="Default"
					className={FIELD_CLASS}
					onChange={(event) => onChange({ ...arg, default: event.target.value || undefined })}
					placeholder="Default (optional)"
					value={arg.default ?? ""}
				/>
			</div>
			<div className="mt-0.5 text-[11px] text-description">
				{arg.kind === "ticket"
					? "The start form offers the task's ticket tag."
					: arg.kind === "branch"
						? "The start form offers the current branch."
						: arg.kind === "choice"
							? "Picked from the list in the start form."
							: "Typed in the start form."}
			</div>
		</div>
	)
}

function DescribeBox({ onDraft }: { onDraft: (definition: AutomationDefinition, guesses: string[], model: string) => void }) {
	const [text, setText] = useState("")
	const [drafting, setDrafting] = useState(false)
	const [error, setError] = useState("")
	const draft = () => {
		setDrafting(true)
		setError("")
		AutomationServiceClient.draftAutomation(StringRequest.create({ value: text }))
			.then((response) => {
				try {
					onDraft(JSON.parse(response.definitionJson) as AutomationDefinition, response.guesses, response.model)
				} catch {
					setError("The draft couldn't be read. Try describing it again.")
				}
			})
			.catch((err) => setError(err?.message ?? String(err)))
			.finally(() => setDrafting(false))
	}
	return (
		<div className="mt-2 rounded-xs border border-editor-group-border px-2 py-1.5" data-testid="builder-describe">
			<div className="font-medium">Describe it, Cline drafts it</div>
			<PromptField
				label="What should it do? Name the steps, which run together, where you want to pick, and any models."
				onChange={setText}
				placeholder="Given a ticket: research it, have Opus and GPT each plan a fix, let me pick, then build it in a worktree."
				placeholders={[]}
				rows={3}
				testId="builder-describe-text"
				value={text}
			/>
			<div className="mt-1.5 flex flex-wrap items-center gap-2">
				<Button
					data-testid="builder-draft"
					disabled={drafting || !text.trim()}
					onClick={draft}
					size="xs"
					variant="secondary">
					{drafting ? "Drafting…" : "Draft it"}
				</Button>
				<span className="text-[11px] text-description">
					One model call, on Settings › Models › Background text. Nothing runs or saves until you do.
				</span>
			</div>
			{error && (
				<InlineNotice className="mt-1.5" tone="error">
					{error}
				</InlineNotice>
			)}
		</div>
	)
}

/**
 * The automation builder: a sidebar page that edits name, arguments and steps with pickers (the
 * composer's model selector, Ask/Act, worktree), shows problems as you go, and writes the readable
 * file on Save. "View file" shows that file; when the panel is wide it sits beside the editor.
 */
export function AutomationBuilder({ target }: { target: AutomationBuilderTarget }) {
	const { automations, loaded, workspaceDir } = useAutomations()
	const existing = target.path ? automations.find((item) => item.path === target.path) : undefined
	const [definition, setDefinition] = useState<AutomationDefinition>(() => existing?.definition ?? emptyAutomation())
	const [scope, setScope] = useState<"workspace" | "global">(existing?.scope ?? (workspaceDir ? "workspace" : "global"))
	const [path, setPath] = useState(target.path)
	const [openStep, setOpenStep] = useState<string | undefined>(definition.steps[0]?.id)
	const [showDescribe, setShowDescribe] = useState(!!target.describe)
	const [guesses, setGuesses] = useState<string[]>([])
	const [draftedWith, setDraftedWith] = useState("")
	const [fromTask, setFromTask] = useState<"loading" | "done" | "">(target.fromTask ? "loading" : "")
	const [showFile, setShowFile] = useState(false)
	const [fileText, setFileText] = useState("")
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const [error, setError] = useState("")
	const [dirty, setDirty] = useState(false)
	const [showPromptEdit, setShowPromptEdit] = useState(!!target.changeWithPrompt)

	// A saved file arrives with the first list after the page opens.
	const [hydrated, setHydrated] = useState(!!existing?.definition || !target.path)
	useEffect(() => {
		if (hydrated || !existing?.definition) return
		setDefinition(existing.definition)
		setScope(existing.scope)
		setOpenStep(existing.definition.steps[0]?.id)
		setHydrated(true)
	}, [existing, hydrated])

	// "Save as an automation" on a task page: its threads become the draft (no model call).
	useEffect(() => {
		if (!target.fromTask) return
		let cancelled = false
		AutomationServiceClient.draftAutomationFromTask(StringRequest.create({ value: target.fromTask }))
			.then((response) => {
				if (cancelled) return
				const draft = JSON.parse(response.definitionJson) as AutomationDefinition
				setDefinition(draft)
				setGuesses(response.guesses)
				setOpenStep(draft.steps[0]?.id)
				setFromTask("done")
			})
			.catch((err) => {
				if (cancelled) return
				setError(err?.message ?? String(err))
				setFromTask("")
			})
		return () => {
			cancelled = true
		}
	}, [target.fromTask])

	const issues = useMemo(() => validateAutomation(definition), [definition])
	const issuesAt = (id: string) => issues.filter((issue) => issue.at === id)
	const general = issues.filter((issue) => !issue.at || issue.at.startsWith("arg:"))

	useEffect(() => {
		if (!showFile) return
		const timer = setTimeout(() => {
			AutomationServiceClient.previewAutomationFile(StringRequest.create({ value: JSON.stringify(definition) }))
				.then((response) => setFileText(response.value))
				.catch((err) => setFileText(`The file couldn't be shown: ${err?.message ?? err}`))
		}, 200)
		return () => clearTimeout(timer)
	}, [definition, showFile])

	const update = (next: AutomationDefinition) => {
		setDefinition(next)
		setSaved(false)
		setDirty(true)
	}
	const updateStep = (index: number, step: AutomationStep) =>
		update({ ...definition, steps: definition.steps.map((candidate, i) => (i === index ? step : candidate)) })
	const moveStep = (index: number, by: -1 | 1) => {
		const steps = [...definition.steps]
		const [step] = steps.splice(index, 1)
		steps.splice(index + by, 0, step)
		update({ ...definition, steps })
	}
	const addStep = (kind: AutomationStepKind) => {
		const step = blankStep(kind, definition.steps)
		update({ ...definition, steps: kind === "task" ? [step, ...definition.steps] : [...definition.steps, step] })
		setOpenStep(step.id)
	}
	const save = () => {
		setSaving(true)
		setError("")
		AutomationServiceClient.saveAutomation(
			SaveAutomationRequest.create({ definitionJson: JSON.stringify(definition), scope, previousPath: path }),
		)
			.then((response) => {
				applyAutomationList(response)
				setPath(response.savedPath)
				setSaved(true)
				setDirty(false)
			})
			.catch((err) => setError(err?.message ?? String(err)))
			.finally(() => setSaving(false))
	}
	const saveBlock = issues.length ? `Fix ${issues.length === 1 ? "the problem" : `${issues.length} problems`} first` : undefined
	const title = automationDisplayName(definition) || "New automation"

	if (path && showPromptEdit) {
		return (
			<div className="flex flex-1 flex-col overflow-hidden" data-testid="automation-builder">
				<BuilderHeader
					onBack={() => setShowPromptEdit(false)}
					title={title === "New automation" ? existing?.name || "Automation" : title}
				/>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<AutomationPromptEdit
						editorDefinition={dirty ? definition : undefined}
						onDrop={() => setShowPromptEdit(false)}
						onKeep={(list) => {
							const entry = list.automations.find((item) => item.path === list.savedPath)
							if (entry?.definitionJson) {
								const kept = JSON.parse(entry.definitionJson) as AutomationDefinition
								setDefinition(kept)
								setScope(entry.scope === "global" ? "global" : "workspace")
								setOpenStep(kept.steps[0]?.id)
								setHydrated(true)
							}
							applyAutomationList(list)
							setPath(list.savedPath)
							setSaved(true)
							setDirty(false)
							setError("")
							setShowPromptEdit(false)
						}}
						path={path}
					/>
				</div>
			</div>
		)
	}

	if (target.path && !hydrated) {
		return (
			<div className="flex flex-1 flex-col overflow-hidden" data-testid="automation-builder">
				<BuilderHeader title="Automation" />
				<div className="px-4 py-3 text-sm text-description">
					{loaded ? "This automation can't be opened in the builder: its file has problems." : "Loading…"}
					{loaded && (
						<LinkButton className="ml-1" onClick={() => openFile(target.path as string)}>
							Open the file
						</LinkButton>
					)}
				</div>
			</div>
		)
	}

	const editor = (
		<div className="min-w-0 flex-1 px-4 pb-4">
			{fromTask === "loading" && (
				<div className="mt-2 text-description" data-testid="builder-from-task-loading">
					Reading the task's threads…
				</div>
			)}
			{fromTask !== "loading" && (showDescribe || (definition.steps.length === 0 && !path && !fromTask)) && (
				<DescribeBox
					onDraft={(draft, nextGuesses, model) => {
						update({ ...draft, arguments: draft.arguments ?? [], steps: draft.steps ?? [] })
						setGuesses(nextGuesses)
						setDraftedWith(model)
						setShowDescribe(false)
						setOpenStep(draft.steps?.[0]?.id)
					}}
				/>
			)}
			{(guesses.length > 0 || draftedWith || fromTask === "done") && (
				<InlineNotice className="mt-2" data-testid="builder-guesses" tone="info">
					<div>
						{fromTask === "done"
							? `Made from the task's threads (${definition.steps.length} ${definition.steps.length === 1 ? "step" : "steps"}). Check it before saving.`
							: `Drafted${draftedWith ? ` with ${draftedWith}` : ""}. Check it before saving.`}
					</div>
					{guesses.length > 0 && (
						<ul className="m-0 mt-1 pl-4">
							{guesses.map((guess) => (
								<li key={guess}>{guess}</li>
							))}
						</ul>
					)}
				</InlineNotice>
			)}

			<div className={SECTION_CLASS}>Basics</div>
			<div className="grid grid-cols-1 gap-x-3 min-[560px]:grid-cols-2">
				<label className="block">
					<span className={LABEL_CLASS}>Name (you type it as /name)</span>
					<input
						className={cn(FIELD_CLASS, "font-mono")}
						data-testid="builder-name"
						onChange={(event) => update({ ...definition, name: slugifyName(event.target.value) })}
						placeholder="ticket-to-pr"
						value={definition.name}
					/>
				</label>
				<label className="block">
					<span className={LABEL_CLASS}>Title (optional)</span>
					<input
						className={FIELD_CLASS}
						onChange={(event) => update({ ...definition, title: event.target.value })}
						placeholder="Ticket to PR"
						value={definition.title}
					/>
				</label>
			</div>
			<label className="block">
				<span className={LABEL_CLASS}>Description</span>
				<input
					className={FIELD_CLASS}
					data-testid="builder-description"
					onChange={(event) => update({ ...definition, description: event.target.value })}
					placeholder="One line on what it does"
					value={definition.description}
				/>
			</label>
			<CostLimitField
				key={`${hydrated}-${fromTask}`}
				onChange={(costLimit) => update({ ...definition, costLimit })}
				value={definition.costLimit}
			/>
			<label className="mt-1.5 block">
				<span className={LABEL_CLASS}>Notes from this automation</span>
				<select
					className={FIELD_CLASS}
					onChange={(event) => update({ ...definition, keepNotes: event.target.value === "keep" || undefined })}
					value={definition.keepNotes ? "keep" : "ask"}>
					<option value="ask">Ask me</option>
					<option value="keep">Keep automatically</option>
				</select>
				{definition.keepNotes && (
					<span className="mt-0.5 block text-[11px] text-description">
						Keeps task notes after each turn. About you, skills and workflows still ask.
					</span>
				)}
			</label>
			<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
				<span className="text-description">Save to</span>
				{(["workspace", "global"] as const).map((value) => (
					<button
						aria-pressed={scope === value}
						className={cn(
							"cursor-pointer rounded-xs border border-solid px-1.5 leading-4 disabled:cursor-default disabled:opacity-50",
							scope === value
								? "border-(--vscode-focusBorder) bg-button-background text-button-foreground"
								: "border-editor-group-border bg-transparent text-foreground hover:bg-list-hover",
						)}
						disabled={value === "workspace" && !workspaceDir}
						key={value}
						onClick={() => {
							setScope(value)
							setSaved(false)
						}}
						title={
							value === "workspace" && !workspaceDir ? "Open a folder to keep automations in the repo" : undefined
						}
						type="button">
						{value === "workspace" ? "This repo" : "Everywhere"}
					</button>
				))}
				<span className="text-description">
					{scope === "workspace"
						? ".clinerules/automations/ (shared with the repo)"
						: "~/.cline/automations/ (just you)"}
				</span>
			</div>

			<div className={SECTION_CLASS}>
				Arguments
				<button
					className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-[11px] normal-case tracking-normal text-link hover:underline"
					data-testid="builder-add-arg"
					onClick={() =>
						update({
							...definition,
							arguments: [...definition.arguments, { name: "", kind: "text", required: false, description: "" }],
						})
					}
					type="button">
					＋ Argument
				</button>
			</div>
			{definition.arguments.length === 0 && (
				<div className="text-[11px] text-description">
					None. Add one for anything that changes per run, like the ticket.
				</div>
			)}
			{definition.arguments.map((arg, index) => (
				<ArgumentRow
					arg={arg}
					// biome-ignore lint/suspicious/noArrayIndexKey: arguments are edited in place, and their names change as you type
					key={index}
					onChange={(next) =>
						update({ ...definition, arguments: definition.arguments.map((a, i) => (i === index ? next : a)) })
					}
					onRemove={() => update({ ...definition, arguments: definition.arguments.filter((_, i) => i !== index) })}
				/>
			))}

			<div className={SECTION_CLASS}>Steps · {definition.steps.length}</div>
			{definition.steps.length === 0 && <div className="text-[11px] text-description">No steps yet. Add one below.</div>}
			<ol className="m-0 list-none p-0" data-testid="builder-steps">
				{definition.steps.map((step, index) => {
					const open = openStep === step.id
					const stepIssues = [
						...issuesAt(step.id),
						...(step.kind === "together" ? step.threads.flatMap((t) => issuesAt(t.id)) : []),
					]
					return (
						<li key={step.id}>
							{index > 0 && (
								<div className="py-0.5 pl-2.5 text-[10.5px] text-description">
									{step.kind === "together" ? "then, together" : "then"}
								</div>
							)}
							<div
								className={cn(
									"rounded-xs border px-2 py-1",
									step.kind === "together" ? "border-link/40" : "border-editor-group-border",
									stepIssues.length > 0 && !open && "border-error/50",
								)}
								data-testid={`builder-step-${step.id}`}>
								<div className="flex min-w-0 items-center gap-1.5">
									<span className="w-4 shrink-0 text-right text-description">{index + 1}</span>
									<button
										aria-expanded={open}
										className="flex min-w-0 flex-1 cursor-pointer flex-col items-start border-0 bg-transparent p-0 text-left text-foreground"
										onClick={() => setOpenStep(open ? undefined : step.id)}
										type="button">
										<span className="flex w-full min-w-0 items-baseline gap-1.5">
											<span className="min-w-0 truncate font-medium">{step.title || step.id}</span>
											<span className="shrink-0 text-[11px] text-description">
												{AUTOMATION_STEP_LABELS[step.kind]}
											</span>
										</span>
										{!open && (
											<span className="w-full truncate text-[11px] text-description">{stepLine(step)}</span>
										)}
									</button>
									<HeaderIconButton
										disabled={index === 0 || step.kind === "task"}
										icon="arrow-up"
										label="Move up"
										onClick={() => moveStep(index, -1)}
									/>
									<HeaderIconButton
										disabled={index === definition.steps.length - 1 || step.kind === "task"}
										icon="arrow-down"
										label="Move down"
										onClick={() => moveStep(index, 1)}
									/>
									<HeaderIconButton
										icon="trash"
										label="Remove step"
										onClick={() =>
											update({ ...definition, steps: definition.steps.filter((_, i) => i !== index) })
										}
									/>
								</div>
								{stepIssues.length > 0 && (
									<ul
										className="m-0 list-none py-0.5 pl-5.5 text-[11px] text-error"
										data-testid={`builder-issues-${step.id}`}>
										{stepIssues.map((issue) => (
											<li key={`${issue.at}-${issue.message}`}>{issue.message}</li>
										))}
									</ul>
								)}
								{open && step.kind !== "task" && (
									<div className="truncate pl-5.5 text-[11px] text-description" title={`{{steps.${step.id}}}`}>
										Later steps use its reply as{" "}
										<span className="font-mono text-foreground">{`{{steps.${step.id}}}`}</span>
									</div>
								)}
								{open && (
									<div className="pl-5.5">
										<BuilderStepEditor
											definition={definition}
											onChange={(next) => updateStep(index, next)}
											step={step}
										/>
									</div>
								)}
							</div>
						</li>
					)
				})}
			</ol>
			<div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
				<span className="text-description">Add a step</span>
				{ADD_KINDS.filter((kind) => kind !== "task" || definition.steps[0]?.kind !== "task").map((kind) => (
					<button
						className="cursor-pointer rounded-full border border-solid border-editor-group-border bg-transparent px-2 leading-4 text-foreground hover:bg-list-hover"
						data-testid={`builder-add-${kind}`}
						key={kind}
						onClick={() => addStep(kind)}
						type="button">
						{AUTOMATION_STEP_LABELS[kind]}
					</button>
				))}
			</div>

			{general.length > 0 && (
				<ul className="m-0 mt-3 list-none p-0 text-[11px] text-error" data-testid="builder-general-issues">
					{general.map((issue) => (
						<li key={issue.message}>{issue.message}</li>
					))}
				</ul>
			)}
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button data-testid="builder-save" disabled={saving || !!saveBlock} onClick={save} size="sm" title={saveBlock}>
					{saving ? "Saving…" : "Save"}
				</Button>
				{!showDescribe && definition.steps.length > 0 && !path && (
					<LinkButton className="text-[11px]" onClick={() => setShowDescribe(true)}>
						Describe it instead
					</LinkButton>
				)}
				<span className="min-w-0 flex-1 truncate text-[11px] text-description" data-testid="builder-status">
					{saved
						? `Saved. Type /${definition.name} in the chat to run it.`
						: saveBlock
							? saveBlock
							: definition.steps.length
								? stepSummary(definition)
								: ""}
				</span>
			</div>
			{error && (
				<InlineNotice className="mt-1.5" tone="error">
					{error}
				</InlineNotice>
			)}
		</div>
	)

	return (
		<div className="flex flex-1 flex-col overflow-hidden" data-testid="automation-builder">
			<BuilderHeader title={title}>
				{path && (
					<LinkButton className="shrink-0 text-[11px]" onClick={() => setShowPromptEdit(true)}>
						Change with a prompt…
					</LinkButton>
				)}
				<HeaderIconButton
					aria-pressed={showFile}
					className={showFile ? "text-foreground" : undefined}
					icon="file-code"
					label={showFile ? "Hide the file" : "View the file it saves"}
					onClick={() => setShowFile((value) => !value)}
				/>
				{path && (
					<HeaderIconButton
						icon="go-to-file"
						label="Open the saved file in the editor"
						onClick={() => openFile(path)}
					/>
				)}
			</BuilderHeader>
			{/* One scroll region: the editor and (when wide) the file beside it scroll together. */}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto min-[700px]:flex-row min-[700px]:items-start">
				{editor}
				{showFile && (
					<section
						className="mx-4 mb-4 min-w-0 rounded-xs border border-editor-group-border min-[700px]:sticky min-[700px]:top-0 min-[700px]:mx-0 min-[700px]:mr-4 min-[700px]:w-[45%]"
						data-testid="builder-file">
						<div className="border-b border-editor-group-border px-2 py-1 text-[11px] text-description">
							{scope === "workspace" ? ".clinerules" : "~/.cline"}/automations/{definition.name || "name"}.md · what
							Save writes
						</div>
						<pre className="ph-no-capture m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-4">
							{fileText}
						</pre>
					</section>
				)}
			</div>
		</div>
	)
}

/** Dollars a run may spend; empty for no limit. Keeps what's typed ("2.") while the number is unfinished. */
function CostLimitField({ value, onChange }: { value: number | undefined; onChange: (next: number | undefined) => void }) {
	const [text, setText] = useState(value === undefined ? "" : String(value))
	return (
		<label className="block">
			<span className={LABEL_CLASS}>Cost limit (optional)</span>
			<span className="flex items-center gap-1.5">
				<span className="text-description">$</span>
				<input
					className={cn(FIELD_CLASS, "w-20 shrink-0")}
					data-testid="builder-cost-limit"
					inputMode="decimal"
					onChange={(event) => {
						const next = event.target.value.replace(/[^0-9.]/g, "")
						setText(next)
						const number = Number(next)
						onChange(next && Number.isFinite(number) && number > 0 ? number : undefined)
					}}
					placeholder="none"
					value={text}
				/>
			</span>
			<span className="mt-0.5 block text-[11px] text-description">
				A run stops itself once its threads spend this much. Resuming allows it again.
			</span>
		</label>
	)
}

function BuilderHeader({
	title,
	children,
	onBack = closeAutomationBuilder,
}: {
	title: string
	children?: React.ReactNode
	onBack?: () => void
}) {
	return (
		<div className="flex min-h-8 items-center gap-1 border-b border-editor-group-border px-2 py-1">
			<HeaderIconButton icon="arrow-left" label="Back" onClick={onBack} />
			<span className="min-w-0 truncate text-xs text-description">Automations ›</span>
			<span className="min-w-0 flex-1 truncate text-xs font-semibold" data-testid="builder-title">
				{title}
			</span>
			{children}
		</div>
	)
}

function openFile(path: string) {
	FileServiceClient.openFile(StringRequest.create({ value: path })).catch((error) =>
		console.error("Failed to open automation:", error),
	)
}

/** Names are typed as `/name`: lowercase, digits, - and _. */
function slugifyName(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9_-]/g, "")
		.slice(0, 64)
}
