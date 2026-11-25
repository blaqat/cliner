import { useLayoutEffect, useRef } from "react"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { FormatBar } from "@/components/docEditor/DocEditor"
import { applyFormat, continueList, type FormatAction, type TextEdit } from "@/components/docEditor/docFormat"
import { cn } from "@/lib/utils"
import { getCurrentPlatform, modKeyLabel } from "@/utils/platformUtils"
import { splitInlineCode } from "./walkthroughUtils"

/** Quick chips from the round 3 mockup; each fills the note box and stays editable. */
export const QUICK_NOTES = ["Why this approach?", "Add a test for this.", "Rename for clarity."]

/** A quick-note suggestion inside the note box: quiet text until hovered, like the composer's icon buttons. */
const CHIP_CLASS =
	"inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-xs border-0 bg-transparent px-1.5 text-[11px] text-description hover:bg-list-hover hover:text-foreground"

/** Tallest the note box grows before it scrolls (about ten lines). */
const NOTE_MAX_HEIGHT = 160

export function InlineCodeProse({ text, className }: { text: string; className?: string }) {
	return (
		<p className={cn("m-0 whitespace-pre-line break-words", className)}>
			{splitInlineCode(text).map((part, index) =>
				part.code ? (
					<code className="rounded-xs bg-code px-1 font-mono text-[11px]" key={index}>
						{part.text}
					</code>
				) : (
					<span key={index}>{part.text}</span>
				),
			)}
		</p>
	)
}

/**
 * A note box with quick chips, as quiet as the quote note in the composer: a plain input box that
 * doesn't light up when focused (the caret is enough), growing with the text, with its suggestions
 * and Done inside. Used by each stop and by the overall note. Esc or Cmd/Ctrl+Enter finishes.
 * A line's note can also be asked instead (Cmd/Ctrl+Shift+Enter): onAsk gets the text.
 */
export function NoteEditor({
	value,
	placeholder,
	label,
	chips,
	className,
	onChange,
	onDone,
	onAsk,
}: {
	value: string
	placeholder: string
	label: string
	chips?: boolean
	className?: string
	onChange: (value: string) => void
	onDone: () => void
	/** Turns the text into an Ask why question on the same lines. */
	onAsk?: () => void
}) {
	const textarea = useRef<HTMLTextAreaElement>(null)
	const pendingSelection = useRef<TextEdit>()
	// Grows with the text (from two lines) like the composer, then scrolls; restores the selection after a format.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
	useLayoutEffect(() => {
		const element = textarea.current
		if (!element) return
		element.style.height = "auto"
		element.style.height = `${Math.min(element.scrollHeight, NOTE_MAX_HEIGHT)}px`
		const selection = pendingSelection.current
		if (selection) {
			pendingSelection.current = undefined
			element.focus()
			element.setSelectionRange(selection.start, selection.end)
		}
	}, [value])
	const apply = (edit: TextEdit) => {
		pendingSelection.current = edit
		onChange(edit.text)
	}
	const format = (action: FormatAction) => {
		const element = textarea.current
		if (element) apply(applyFormat(action, value, element.selectionStart, element.selectionEnd))
	}
	return (
		<div
			className={cn("mt-2 rounded-xs border border-solid border-input-border bg-input-background", className)}
			data-testid="note-editor">
			<textarea
				aria-label={label}
				autoFocus
				className="block w-full resize-none border-0 bg-transparent px-2 pt-1.5 pb-1 font-[inherit] text-xs leading-normal text-input-foreground outline-none! placeholder:text-input-placeholder"
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (onAsk && event.key === "Enter" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
						event.preventDefault()
						event.stopPropagation()
						onAsk()
						return
					}
					if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
						event.preventDefault()
						event.stopPropagation()
						onDone()
						return
					}
					const mod = getCurrentPlatform() === "mac" ? event.metaKey : event.ctrlKey
					const shortcut = ({ b: "bold", e: "code", k: "link" } as Record<string, FormatAction>)[
						event.key.toLowerCase()
					]
					if (mod && shortcut) {
						event.preventDefault()
						event.stopPropagation()
						format(shortcut)
						return
					}
					if (
						event.key === "Enter" &&
						!event.shiftKey &&
						event.currentTarget.selectionStart === event.currentTarget.selectionEnd
					) {
						const edit = continueList(value, event.currentTarget.selectionStart)
						if (edit) {
							event.preventDefault()
							apply(edit)
						}
					}
				}}
				placeholder={placeholder}
				ref={textarea}
				rows={2}
				style={{ maxHeight: NOTE_MAX_HEIGHT }}
				value={value}
			/>
			<div className="flex flex-wrap items-center gap-x-0.5 gap-y-0 px-1 pb-1">
				{chips &&
					QUICK_NOTES.map((text) => (
						<button
							className={CHIP_CLASS}
							key={text}
							onClick={() => {
								onChange(value.trim() ? `${value.trimEnd()} ${text}` : text)
								textarea.current?.focus()
							}}
							type="button">
							<span aria-hidden className="codicon codicon-add text-[10px]! opacity-70" />
							{text.replace(/[.?]$/, "")}
						</button>
					))}
				{onAsk && (
					<button
						className={CHIP_CLASS}
						data-testid="note-ask-instead"
						onClick={onAsk}
						title={`Ask why instead (${modKeyLabel()}+Shift+Enter): asks what you typed about these lines and starts a model call. The answer shows here; the note is removed once it's answered.`}
						type="button">
						<span aria-hidden className="codicon codicon-sparkle text-[11px]!" />
						Ask instead
					</button>
				)}
				<span className="flex-1" />
				<FormatBar compact onFormat={format} />
				<span aria-hidden className="shrink-0 text-[10.5px] text-description">
					{getCurrentPlatform() === "mac" ? "⌘↵" : "Ctrl+↵"}
				</span>
				<button
					aria-label="Done"
					className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground"
					onClick={onDone}
					title={`Done (${modKeyLabel()}+Enter or Esc)`}
					type="button">
					<span aria-hidden className="codicon codicon-check text-[14px]!" />
				</button>
			</div>
		</div>
	)
}

/** A saved note, shown as a quote on its stop or under Overall; click to edit. */
export function NoteQuote({ label, note, onEdit }: { label: string; note: string; onEdit: () => void }) {
	// A div acting as the button: the rendered note can hold links and code buttons of its own.
	return (
		<div
			className="mt-2 block w-full cursor-pointer rounded-xs border-0 border-l-2 border-solid border-link bg-code px-2 py-1.5 text-left text-xs text-foreground hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
			onClick={(event) => {
				if (!(event.target as HTMLElement).closest("a, button")) onEdit()
			}}
			onKeyDown={(event) => {
				if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault()
					onEdit()
				}
			}}
			role="button"
			tabIndex={0}
			title="Edit">
			<span className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-link">
				<span aria-hidden className="codicon codicon-comment text-[11px]!" />
				{label}
			</span>
			<div className="break-words [&_.inline-markdown-block_p:last-child]:mb-0 [&_.inline-markdown-block_p]:my-0">
				<MarkdownBlock compact markdown={note} />
			</div>
		</div>
	)
}
