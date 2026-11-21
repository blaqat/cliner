import type { NotebookActionRequest } from "@shared/proto/cline/task_group"
import { looksRunnable } from "@shared/skillsets"
import type { NotebookChange } from "@shared/task-groups"
import { useEffect, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { DocEditor } from "@/components/docEditor/DocEditor"
import { MarkedNote } from "@/components/docEditor/MarkedNote"
import { NotebookDiff } from "@/components/taskGroup/NotebookDiff"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { RunsCodeChip } from "./SkillBits"

const FIELD_CLASS =
	"w-full min-w-0 rounded-xs border border-solid border-input-border bg-input-background px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"

/** Two or three choices as one pill, like the composer's Ask / Act switch. */
export function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	label: string
	value: T
	options: { value: T; label: string; title?: string }[]
	onChange: (value: T) => void
	disabled?: boolean
}) {
	return (
		<div
			aria-label={label}
			className="inline-flex shrink-0 overflow-hidden rounded-full border border-solid border-input-border text-[11px]"
			role="radiogroup">
			{options.map((option) => (
				<button
					aria-checked={value === option.value}
					className={cn(
						"cursor-pointer border-0 px-2.5 py-0.5 font-[inherit] text-[11px] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-default",
						value === option.value
							? "bg-(--vscode-button-background) text-(--vscode-button-foreground)"
							: "bg-transparent text-description hover:text-foreground",
					)}
					disabled={disabled}
					key={option.value}
					onClick={() => value !== option.value && onChange(option.value)}
					role="radio"
					title={option.title}
					type="button">
					{option.label}
				</button>
			))}
		</div>
	)
}

/** The files a staged skill will write, scripts flagged. */
export function draftFiles(change: NotebookChange): { path: string; runsCode: boolean }[] {
	const kind = change.skill?.kind ?? "skill"
	const main = kind === "skill" ? "SKILL.md" : `${change.name}.md`
	const extra = kind === "skill" ? (change.skill?.files ?? []) : []
	return [{ path: main, runsCode: false }, ...extra.map((file) => ({ path: file.path, runsCode: looksRunnable(file.path) }))]
}

/**
 * A staged skill or workflow opened from the review row: what it is (Kind),
 * where it goes (Where), its name and description, its files, and the body
 * with Preview / Edit. Keep writes it and switches it on.
 */
export function OpenedSkillDraft({
	change,
	sending,
	hasWorkspace,
	onKeep,
	onDrop,
	onAction,
}: {
	change: NotebookChange
	sending: boolean
	hasWorkspace: boolean
	onKeep: () => void
	onDrop: () => void
	onAction: (action: string, extra?: Partial<NotebookActionRequest>) => void
}) {
	const draft = change.skill
	const kind = draft?.kind ?? "skill"
	const scope = draft?.scope ?? "global"
	const [editing, setEditing] = useState(false)
	const [asDiff, setAsDiff] = useState(false)
	const [name, setName] = useState(change.name)
	const [description, setDescription] = useState(change.description)
	useEffect(() => setName(change.name), [change.name])
	useEffect(() => setDescription(change.description), [change.description])
	const content = change.content ?? ""
	const [showBoth, setShowBoth] = useState(false)
	const files = draftFiles(change)
	const scripts = files.filter((file) => file.runsCode).length
	const editsExisting = change.op === "update" && !!draft?.targetPath

	// Every change sends the whole target (proto strings can't say "unchanged").
	const target = (patch: Partial<NotebookActionRequest>) =>
		onAction("skill_target", {
			kind,
			isGlobal: scope === "global",
			name: change.name,
			description: change.description,
			...patch,
		})
	const commitName = () => {
		const trimmed = name.trim()
		if (trimmed && trimmed !== change.name) target({ name: trimmed })
		else setName(change.name)
	}
	const commitDescription = () => {
		if (description.trim() !== change.description) target({ description: description.trim() })
	}
	// Keep takes fields the user hasn't left yet with it, in one step.
	const keep = () => {
		const trimmedName = name.trim()
		const nameEdited = !editsExisting && !!trimmedName && trimmedName !== change.name
		const descriptionEdited = kind === "skill" && description.trim() !== change.description
		if (!nameEdited && !descriptionEdited) return onKeep()
		onAction("skill_target_keep", {
			kind,
			isGlobal: scope === "global",
			name: nameEdited ? trimmedName : change.name,
			description: descriptionEdited ? description.trim() : change.description,
		})
	}

	return (
		<div className="mt-2 border-0 border-t border-solid border-editor-group-border pt-2" data-testid="skill-draft-opened">
			{draft?.conflict && (
				<InlineNotice className="mb-2 bg-(--vscode-editor-background)" tone="warning">
					Changed on disk: {Object.keys(draft.conflict).join(", ")}. Mine is the file on disk. Theirs is the proposed
					change.
					<div className="mt-1.5 flex flex-wrap gap-1.5">
						<Button disabled={sending} onClick={onDrop} size="xs" variant="secondary">
							Keep mine
						</Button>
						<Button disabled={sending} onClick={() => onAction("skill_keep_theirs")} size="xs">
							Keep theirs
						</Button>
						<Button onClick={() => setShowBoth((value) => !value)} size="xs" variant="secondary">
							Open both
						</Button>
					</div>
					{showBoth &&
						Object.entries(draft.conflict).map(([file, disk]) => (
							<div className="mt-2" key={file}>
								<div className="break-all">{file} · Mine on disk</div>
								<pre className="whitespace-pre-wrap break-all">
									{disk === null
										? "File removed"
										: new TextDecoder().decode(Uint8Array.from(atob(disk), (char) => char.charCodeAt(0)))}
								</pre>
								<div>Theirs from this turn</div>
								<pre className="whitespace-pre-wrap break-all">
									{file === "SKILL.md" || kind === "workflow"
										? content
										: draft.files?.find((entry) => entry.path === file)?.content}
								</pre>
							</div>
						))}
				</InlineNotice>
			)}
			{change.summary && <p className="m-0 mb-2 italic text-description">“{change.summary}”</p>}
			<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
				<span className="text-[11px] text-description">Kind</span>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Segmented
						disabled={sending}
						label="Kind"
						onChange={(value) => target({ kind: value })}
						options={[
							{ value: "skill", label: "Skill" },
							{ value: "workflow", label: "Workflow" },
						]}
						value={kind}
					/>
				</div>
				<span />
				<span className="text-[11px] text-description">
					{kind === "skill"
						? "Cline loads a skill by itself when a task matches its description."
						: `A workflow waits for you to type /${change.name}.`}
				</span>
				<span className="text-[11px] text-description">Where</span>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Segmented
						disabled={sending || editsExisting}
						label="Where"
						onChange={(value) => target({ isGlobal: value === "global" })}
						options={[
							{ value: "global", label: "All projects" },
							{
								value: "workspace",
								label: "This workspace",
								title: hasWorkspace ? undefined : "Open a folder first",
							},
						]}
						value={scope}
					/>
					{editsExisting && <span className="text-[11px] text-description">edits the one you have</span>}
					{!editsExisting && scope === "workspace" && !hasWorkspace && (
						<span className="text-[11px] text-warning">No folder is open; switch to All projects to keep it.</span>
					)}
				</div>
				<label className="text-[11px] text-description" htmlFor={`skill-name-${change.slug}`}>
					Name
				</label>
				<input
					aria-label="Skill name"
					className={cn(FIELD_CLASS, "font-mono")}
					disabled={sending || editsExisting}
					id={`skill-name-${change.slug}`}
					onBlur={commitName}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
					value={name}
				/>
				{kind === "skill" && (
					<>
						<label className="text-[11px] text-description" htmlFor={`skill-description-${change.slug}`}>
							When
						</label>
						<input
							aria-label="Skill description"
							className={FIELD_CLASS}
							disabled={sending}
							id={`skill-description-${change.slug}`}
							onBlur={commitDescription}
							onChange={(event) => setDescription(event.target.value)}
							onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
							placeholder="When should Cline use it?"
							value={description}
						/>
					</>
				)}
				<span className="self-start pt-0.5 text-[11px] text-description">Files</span>
				<ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
					{files.map((file) => (
						<li className="flex min-w-0 items-center gap-1.5 text-[11px]" key={file.path}>
							<span
								aria-hidden
								className={cn(
									"codicon shrink-0 text-[11px]!",
									file.runsCode ? "codicon-terminal text-warning" : "codicon-file text-description",
								)}
							/>
							<span className="min-w-0 truncate font-mono">{file.path}</span>
							{file.runsCode && <RunsCodeChip />}
						</li>
					))}
				</ul>
			</div>
			<div className="mt-2">
				{editing ? (
					<DocEditor
						initialMode="edit"
						label={`${change.name} body`}
						onSave={async (body) => {
							onAction("save_pending", { content: body, baseContent: content })
							setEditing(false)
						}}
						value={content}
					/>
				) : asDiff ? (
					<NotebookDiff lines={change.diff ?? []} />
				) : (
					<div className="rounded-xs bg-(--vscode-editor-background) px-1 py-1">
						<MarkedNote content={content} diff={change.op === "create" ? [] : (change.diff ?? [])} />
					</div>
				)}
			</div>
			{!editing && (
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					<Button
						aria-label={`Keep ${change.name}`}
						disabled={sending || !!draft?.conflict}
						onClick={keep}
						// Don't blur a field on press: the field's own save would race the Keep.
						onMouseDown={(event) => event.preventDefault()}
						size="xs">
						Keep this one
					</Button>
					<Button aria-label={`Drop ${change.name}`} disabled={sending} onClick={onDrop} size="xs" variant="secondary">
						Drop
					</Button>
					<Button
						aria-label={`Edit ${change.name}`}
						disabled={sending}
						onClick={() => setEditing(true)}
						size="xs"
						variant="secondary">
						Edit
					</Button>
					<span className="flex-1" />
					{change.op === "update" && (
						<LinkButton className="text-[11px]" onClick={() => setAsDiff((value) => !value)}>
							{asDiff ? `Show as ${kind}` : "Show as diff"}
						</LinkButton>
					)}
					<span className="text-[11px] text-description">
						{scripts ? `${scripts} script${scripts === 1 ? "" : "s"} · ` : ""}on once kept
					</span>
				</div>
			)}
		</div>
	)
}
