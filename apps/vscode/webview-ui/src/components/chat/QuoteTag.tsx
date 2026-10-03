import { AnimatePresence, motion } from "framer-motion"
import { QuoteIcon, XIcon } from "lucide-react"
import React, { memo, useCallback, useEffect, useRef, useState } from "react"
import QuotedMessagePreview from "@/components/chat/QuotedMessagePreview"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useReducedMotionPreference } from "@/hooks/useReducedMotionPreference"
import type { QuoteDraft } from "./chat-view/types/chatTypes"

interface QuoteTagProps {
	quote: QuoteDraft
	/** Opens the note editor on mount, e.g. for a quote that was just added. */
	autoOpen?: boolean
	onRemove: () => void
	onNoteChange: (note: string) => void
	/** Returns focus to the composer after the editor closes via Enter/Escape. */
	onDone: () => void
	triggerRef?: React.Ref<HTMLButtonElement>
}

/**
 * Compact chip for one quote in the composer. Hover shows the full text and note;
 * click or Enter opens the note editor; Backspace/Delete removes it.
 */
export const QuoteTag = memo(({ quote, autoOpen, onRemove, onNoteChange, onDone, triggerRef }: QuoteTagProps) => {
	const [editorOpen, setEditorOpen] = useState(!!autoOpen)
	const [tooltipOpen, setTooltipOpen] = useState(false)
	const doneRef = useRef(false)
	const excerpt = quote.text.replace(/\s+/g, " ").trim()
	const note = quote.note.trim()

	const openEditor = useCallback(() => {
		setTooltipOpen(false)
		setEditorOpen(true)
	}, [])

	const finishEditing = useCallback(() => {
		doneRef.current = true
		setEditorOpen(false)
	}, [])

	return (
		<span
			className="group inline-flex h-5 max-w-[200px] shrink-0 items-center rounded-xs border border-input-border bg-muted text-xs text-foreground hover:border-border focus-within:border-border"
			data-testid="quote-tag">
			<Popover onOpenChange={setEditorOpen} open={editorOpen}>
				<Tooltip onOpenChange={(open) => setTooltipOpen(open && !editorOpen)} open={tooltipOpen && !editorOpen}>
					<TooltipTrigger asChild>
						<PopoverTrigger asChild>
							<button
								aria-label={`Quote: ${excerpt}${note ? ` (note: ${note})` : ""}. Press Enter to edit the note, Delete to remove.`}
								className="flex h-full min-w-0 cursor-pointer items-center gap-1 border-0 bg-transparent py-0 pr-0.5 pl-1.5 text-inherit outline-none"
								onBlur={() => setTooltipOpen(false)}
								onFocus={() => setTooltipOpen(!editorOpen)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault()
										openEditor()
									} else if (event.key === "Backspace" || event.key === "Delete") {
										event.preventDefault()
										onRemove()
									}
								}}
								onMouseEnter={() => setTooltipOpen(!editorOpen)}
								onMouseLeave={() => setTooltipOpen(false)}
								ref={triggerRef}
								type="button">
								<QuoteIcon aria-hidden className="shrink-0 text-description" size={11} />
								<span className="truncate" data-testid="quote-tag-excerpt">
									{excerpt}
								</span>
								{note && (
									<span
										aria-hidden
										className="size-1.5 shrink-0 rounded-full bg-(--vscode-focusBorder)"
										data-testid="quote-tag-note-indicator"
									/>
								)}
							</button>
						</PopoverTrigger>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs" side="top">
						<span className="flex flex-col gap-1" data-testid="quote-tag-tooltip">
							<span className="line-clamp-6 whitespace-pre-wrap break-words">{quote.text}</span>
							{note && <span className="text-description">Note: {note}</span>}
						</span>
					</TooltipContent>
				</Tooltip>
				<PopoverContent
					align="start"
					className="menu-rise w-80 max-w-[calc(100vw-2rem)] p-1"
					data-testid="quote-tag-editor"
					onCloseAutoFocus={(event) => {
						if (doneRef.current) {
							doneRef.current = false
							event.preventDefault()
							onDone()
						}
					}}
					onEscapeKeyDown={(event) => {
						event.preventDefault()
						finishEditing()
					}}
					side="top">
					<QuotedMessagePreview
						autoFocusNote
						compact
						note={quote.note}
						onDismiss={() => {
							setEditorOpen(false)
							onRemove()
						}}
						onNoteChange={onNoteChange}
						onNoteDone={finishEditing}
						text={quote.text}
					/>
				</PopoverContent>
			</Popover>
			<button
				aria-label="Remove quote"
				className="flex h-full shrink-0 cursor-pointer items-center border-0 bg-transparent px-0.5 text-description hover:text-foreground"
				onClick={onRemove}
				tabIndex={-1}
				title="Remove quote"
				type="button">
				<XIcon size={11} />
			</button>
		</span>
	)
})

interface QuoteTagListProps {
	quotes: QuoteDraft[]
	setQuotes: React.Dispatch<React.SetStateAction<QuoteDraft[]>>
	/** Index of a quote that was just added; its editor opens so the note can be typed right away. */
	autoOpenIndex?: number
	focusComposer: () => void
}

/** Stable keys for id-less quotes: the text plus its occurrence, so removals don't re-key the rest. */
function quoteKeys(quotes: QuoteDraft[]): string[] {
	const seen = new Map<string, number>()
	return quotes.map((quote) => {
		const count = seen.get(quote.text) ?? 0
		seen.set(quote.text, count + 1)
		return `${count}:${quote.text}`
	})
}

/**
 * One scrollable row of quote chips that sits inside the composer's input box.
 */
export const QuoteTagList = ({ quotes, setQuotes, autoOpenIndex, focusComposer }: QuoteTagListProps) => {
	const reduceMotion = useReducedMotionPreference()
	const listRef = useRef<HTMLDivElement>(null)
	const triggers = useRef(new Map<string, HTMLButtonElement>())
	const pendingFocusRef = useRef<number | null>(null)
	const keys = quoteKeys(quotes)

	// After a removal from inside the row, keep focus there (next chip, else previous) or return it to the composer.
	useEffect(() => {
		const index = pendingFocusRef.current
		if (index === null) {
			return
		}
		pendingFocusRef.current = null
		const key = keys[Math.min(index, keys.length - 1)]
		const target = key === undefined ? undefined : triggers.current.get(key)
		if (target) {
			target.focus()
		} else {
			focusComposer()
		}
	})

	const remove = (index: number) => {
		if (listRef.current?.contains(document.activeElement)) {
			pendingFocusRef.current = index
		}
		setQuotes((current) => current.filter((_, i) => i !== index))
	}

	return (
		<div
			className="flex items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
			data-testid="quote-tag-list"
			ref={listRef}>
			<AnimatePresence initial={false}>
				{quotes.map((quote, index) => (
					<motion.span
						animate={{ opacity: 1, scale: 1 }}
						className="flex shrink-0"
						exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.9 }}
						initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
						key={keys[index]}
						transition={{ duration: reduceMotion ? 0 : 0.14, ease: "easeOut" }}>
						<QuoteTag
							autoOpen={index === autoOpenIndex}
							onDone={focusComposer}
							onNoteChange={(note) =>
								setQuotes((current) => current.map((q, i) => (i === index ? { ...q, note } : q)))
							}
							onRemove={() => remove(index)}
							quote={quote}
							triggerRef={(el) => {
								if (el) {
									triggers.current.set(keys[index], el)
								} else {
									triggers.current.delete(keys[index])
								}
							}}
						/>
					</motion.span>
				))}
			</AnimatePresence>
		</div>
	)
}
