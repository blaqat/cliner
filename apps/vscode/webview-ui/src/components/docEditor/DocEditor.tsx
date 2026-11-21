import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getCurrentPlatform, modKeyLabel } from "@/utils/platformUtils"
import { applyFormat, continueList, type FormatAction, type TextEdit } from "./docFormat"

export type DocEditorMode = "preview" | "edit"

const SWITCH_CLASS =
	"relative grid h-5 shrink-0 grid-cols-2 select-none items-stretch overflow-hidden rounded-full border border-solid border-input-border p-0 text-[11px] leading-none font-medium"

const SLIDE_CLASS =
	"transition-transform duration-200 ease-out motion-reduce:transition-none [.vscode-reduce-motion_&]:transition-none"

/** `( Preview | Edit )`: the same sliding pill as the composer's Ask / Act switch. */
export function PreviewEditSwitch({ mode, onChange }: { mode: DocEditorMode; onChange: (mode: DocEditorMode) => void }) {
	const options: { value: DocEditorMode; label: string }[] = [
		{ value: "preview", label: "Preview" },
		{ value: "edit", label: "Edit" },
	]
	return (
		<div
			aria-label="View"
			className={SWITCH_CLASS}
			data-testid="doc-editor-switch"
			onKeyDown={(event) => {
				// A radio group moves with the arrow keys, and focus follows the choice.
				if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
				event.preventDefault()
				const next = mode === "preview" ? "edit" : "preview"
				onChange(next)
				const target = event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)
				target?.focus()
			}}
			role="radiogroup">
			<span
				aria-hidden
				className={cn("absolute inset-y-0 left-0 w-1/2 rounded-full bg-(--vscode-button-background)", SLIDE_CLASS)}
				style={{ transform: mode === "preview" ? "translateX(0)" : "translateX(100%)" }}
			/>
			{options.map((option) => (
				<button
					aria-checked={mode === option.value}
					className={cn(
						"relative flex cursor-pointer items-center justify-center border-0 bg-transparent px-2 font-[inherit] text-[11px] transition-colors duration-200 focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-(--vscode-focusBorder) motion-reduce:transition-none",
						mode === option.value ? "text-(--vscode-button-foreground)" : "text-description hover:text-foreground",
					)}
					data-mode={option.value}
					key={option.value}
					onClick={() => onChange(option.value)}
					role="radio"
					tabIndex={mode === option.value ? 0 : -1}
					type="button">
					{option.label}
				</button>
			))}
		</div>
	)
}

interface FormatButton {
	action: FormatAction
	icon: string
	label: string
	key?: string
}

const FORMAT_BUTTONS: FormatButton[] = [
	{ action: "bold", icon: "codicon-bold", label: "Bold", key: "B" },
	{ action: "italic", icon: "codicon-italic", label: "Italic", key: "I" },
	{ action: "code", icon: "codicon-code", label: "Code", key: "E" },
	{ action: "link", icon: "codicon-link", label: "Link", key: "K" },
	{ action: "heading", icon: "codicon-symbol-text", label: "Heading" },
	{ action: "bullet", icon: "codicon-list-unordered", label: "Bulleted list" },
	{ action: "numbered", icon: "codicon-list-ordered", label: "Numbered list" },
	{ action: "task", icon: "codicon-checklist", label: "Checklist" },
	{ action: "codeblock", icon: "codicon-terminal", label: "Code block" },
]

const SHORTCUTS: Record<string, FormatAction> = { b: "bold", i: "italic", e: "code", k: "link" }

/** The small format bar: icon buttons that wrap or prefix the selection. */
export function FormatBar({ onFormat, compact }: { onFormat: (action: FormatAction) => void; compact?: boolean }) {
	const mod = modKeyLabel()
	const plus = getCurrentPlatform() === "mac" ? "" : "+"
	return (
		<div aria-label="Format" className="flex min-w-0 flex-wrap items-center gap-0.5" role="toolbar">
			{FORMAT_BUTTONS.filter((button) => !compact || ["bold", "code", "bullet", "link"].includes(button.action)).map(
				(button) => (
					<button
						aria-label={button.label}
						className="flex size-5.5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"
						key={button.action}
						// Keep the textarea's selection: the click must not move focus first.
						onClick={() => onFormat(button.action)}
						onMouseDown={(event) => event.preventDefault()}
						title={button.key ? `${button.label} (${mod}${plus}${button.key})` : button.label}
						type="button">
						<span aria-hidden className={cn("codicon text-[13px]!", button.icon)} />
					</button>
				),
			)}
		</div>
	)
}

export interface DocEditorProps {
	/** The saved markdown body. */
	value: string
	/** Saves the body (and any field edits the caller holds). Throwing keeps the draft and shows why. */
	onSave: (body: string) => Promise<void> | void
	/** Accessible name of the text box, e.g. "Note body". */
	label: string
	/** Front matter as fields, above the body in both modes. */
	fields?: ReactNode
	/** The caller's field edits are unsaved; Save applies them with the body. */
	fieldsDirty?: boolean
	/** Drops the caller's field edits along with the body draft. */
	onDiscardFields?: () => void
	/** Left of the footer: size meter, location. */
	status?: ReactNode
	/** Called as the body changes, e.g. to update a size meter live. */
	onDraftChange?: (body: string) => void
	/** Replaces the default rendered preview (MarkdownBlock). */
	renderPreview?: (body: string) => ReactNode
	/** Shown in Preview when the body is empty. */
	emptyText?: string
	/** Why saving is blocked right now (shown in the footer; Save stays off). */
	blockedReason?: string
	/** Read-only (e.g. a remote rule): Preview only, with this reason instead of the switch. */
	readOnlyReason?: string
	initialMode?: DocEditorMode
	/** Tight variant for small boxes (walkthrough notes): fewer format buttons, no footer hints. */
	compact?: boolean
	className?: string
}

/**
 * The doc viewer and editor for every markdown thing Cline keeps (notes,
 * About you, skills, rules, workflows, walkthrough notes). Preview renders the
 * page; Edit swaps the body for a plain text box with a format bar. Front
 * matter stays as fields in both. ⌘S saves; Esc goes back to Preview and keeps
 * the unsaved text as a draft, so nothing asks and nothing is lost.
 */
export function DocEditor({
	value,
	onSave,
	label,
	fields,
	fieldsDirty,
	onDiscardFields,
	status,
	onDraftChange,
	renderPreview,
	emptyText = "Empty. Switch to Edit to write.",
	blockedReason,
	readOnlyReason,
	initialMode = "preview",
	compact,
	className,
}: DocEditorProps) {
	const [mode, setMode] = useState<DocEditorMode>(readOnlyReason ? "preview" : initialMode)
	const [draft, setDraft] = useState<string>()
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string>()
	const [saved, setSaved] = useState(false)
	const textarea = useRef<HTMLTextAreaElement>(null)
	const pendingSelection = useRef<TextEdit>()
	const body = draft ?? value
	const dirty = draft !== undefined || !!fieldsDirty

	// biome-ignore lint/correctness/useExhaustiveDependencies: report the body whenever it changes
	useEffect(() => {
		onDraftChange?.(body)
	}, [body])

	// Grows with the text, so the page keeps the only scrollbar; restores the selection after a format.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text or mode changes
	useLayoutEffect(() => {
		const element = textarea.current
		if (!element) return
		element.style.height = "auto"
		element.style.height = `${element.scrollHeight + 2}px`
		const selection = pendingSelection.current
		if (selection) {
			pendingSelection.current = undefined
			element.focus()
			element.setSelectionRange(selection.start, selection.end)
		}
	}, [body, mode])

	const change = (next: string) => {
		setSaved(false)
		setDraft(next === value ? undefined : next)
	}

	const apply = (edit: TextEdit) => {
		pendingSelection.current = edit
		change(edit.text)
	}

	const format = (action: FormatAction) => {
		const element = textarea.current
		if (!element) return
		apply(applyFormat(action, body, element.selectionStart, element.selectionEnd))
	}

	const save = async () => {
		if (!dirty || saving || blockedReason) return
		setSaving(true)
		setError(undefined)
		try {
			await onSave(body)
			setDraft(undefined)
			setSaved(true)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setSaving(false)
		}
	}

	const discard = () => {
		setDraft(undefined)
		setError(undefined)
		onDiscardFields?.()
	}

	const mod = modKeyLabel()
	const plus = getCurrentPlatform() === "mac" ? "" : "+"
	const isMod = (event: React.KeyboardEvent) => (getCurrentPlatform() === "mac" ? event.metaKey : event.ctrlKey)

	return (
		<div
			className={cn("flex flex-col gap-2", className)}
			data-testid="doc-editor"
			onKeyDown={(event) => {
				if (isMod(event) && event.key.toLowerCase() === "s") {
					event.preventDefault()
					event.stopPropagation()
					void save()
				}
			}}>
			{fields}
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				{readOnlyReason ? (
					<span className="flex items-center gap-1 text-[11px] text-description">
						<span aria-hidden className="codicon codicon-lock text-[11px]!" />
						{readOnlyReason}
					</span>
				) : (
					<PreviewEditSwitch mode={mode} onChange={setMode} />
				)}
				{mode === "edit" && <FormatBar compact={compact} onFormat={format} />}
			</div>
			{mode === "edit" ? (
				<textarea
					aria-label={label}
					autoFocus
					className={cn(
						"block w-full resize-none overflow-hidden rounded-xs border border-solid border-input-border bg-input-background px-2 py-1.5 font-mono text-xs leading-normal text-input-foreground outline-none focus:border-(--vscode-focusBorder)",
						compact ? "min-h-12" : "min-h-32",
					)}
					onChange={(event) => change(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault()
							event.stopPropagation()
							setMode("preview")
							return
						}
						if (isMod(event) && SHORTCUTS[event.key.toLowerCase()]) {
							event.preventDefault()
							format(SHORTCUTS[event.key.toLowerCase()])
							return
						}
						if (event.key === "Enter" && !event.shiftKey && !event.altKey && !isMod(event)) {
							const element = event.currentTarget
							if (element.selectionStart !== element.selectionEnd) return
							const edit = continueList(body, element.selectionStart)
							if (edit) {
								event.preventDefault()
								apply(edit)
							}
						}
					}}
					ref={textarea}
					spellCheck
					value={body}
				/>
			) : (
				<div
					className="ph-no-capture min-w-0 text-xs"
					data-testid="doc-editor-preview"
					onDoubleClick={readOnlyReason ? undefined : () => setMode("edit")}>
					{body.trim() ? (
						(renderPreview?.(body) ?? <MarkdownBlock markdown={body} />)
					) : (
						<p className="m-0 text-description">{emptyText}</p>
					)}
				</div>
			)}
			{error && (
				<InlineNotice role="alert" tone="error">
					{error}
				</InlineNotice>
			)}
			{(!compact || dirty || status || blockedReason) && (
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-description">
					{status}
					<span className="flex-1" />
					{blockedReason ? (
						<span className="text-(--vscode-editorWarning-foreground)" role="status">
							{blockedReason}
						</span>
					) : dirty ? (
						<span role="status">{mode === "preview" ? "Unsaved draft" : "Unsaved"}</span>
					) : saved ? (
						<span role="status">Saved</span>
					) : null}
					{dirty && (
						<>
							<Button disabled={saving} onClick={discard} size="xs" variant="ghost">
								Discard
							</Button>
							<Button
								disabled={saving || !!blockedReason}
								onClick={() => void save()}
								size="xs"
								title={`Save (${mod}${plus}S)`}>
								{saving ? "Saving…" : "Save"}
							</Button>
						</>
					)}
					{!compact && !dirty && mode === "edit" && (
						<span aria-hidden>
							{mod}
							{plus}S save · Esc back to Preview
						</span>
					)}
				</div>
			)}
		</div>
	)
}
