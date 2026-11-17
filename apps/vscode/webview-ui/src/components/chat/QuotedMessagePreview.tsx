import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React from "react"
import styled from "styled-components"

const PreviewContainer = styled.div<{ $compact?: boolean }>`
	background-color: var(--vscode-input-background); /* Outer box matches text area */
	/* border-left: 3px solid var(--vscode-textBlockQuote-border); */ /* Remove left border */
	/* border-top: 1px solid var(--vscode-editorGroup-border); */ /* Remove top border */
	padding: 4px 4px 4px 4px; /* Removed bottom padding */
	margin: 0px 15px 0 15px; /* Remove bottom+top margin, equal left/right */
	border-radius: 2px 2px 0 0; /* Only round top corners */
	display: flex;
	/* flex-direction: column; */ /* No longer needed as Label is removed */
	position: relative; /* Keep for button positioning */

	${(props) => (props.$compact ? "margin: 0; padding: 0; background-color: transparent;" : "")}
`

// Removed Label component

const ContentRow = styled.div`
	/* Mix outer background with white to ensure a much lighter inner box */
	background-color: color-mix(in srgb, var(--vscode-input-background) 70%, white 30%);
	border-radius: 2px 2px 2px 2px; /* Round top corners, square bottom corners */
	padding: 8px 10px 10px 8px; /* Reduced left padding */
	display: flex;
	align-items: flex-start; /* Align items to the top */
	justify-content: space-between;
	width: 100%;
`

const TextContainer = styled.div`
	grow: 1;
	margin: 0 2px; /* Further reduced space around text */
	white-space: pre-wrap;
	word-break: break-word;
	overflow: hidden;
	text-overflow: ellipsis;
	display: -webkit-box;
	-webkit-line-clamp: 3;
	-webkit-box-orient: vertical;
	font-size: var(--vscode-editor-font-size); /* Use editor font size */
	opacity: 0.9; /* Slightly muted text */
	line-height: 1.4; /* Improve readability */
	max-height: calc(1.4 * var(--vscode-editor-font-size) * 3); /* approx 3 lines */
`

const DismissButton = styled(VSCodeButton)`
	/* margin-left: auto; */ /* Removed as ContentRow handles spacing */
	shrink: 0; /* Prevent button from shrinking */
	min-width: 22px;
	height: 22px;
	padding: 0;
	/* margin-top: 20px; */ /* Remove top margin */
	display: flex;
	align-items: center;
	justify-content: center;
`

const ReplyIcon = styled.span`
	color: var(--vscode-descriptionForeground);
	margin-right: 2px; /* Further reduced space between icon and text */
	shrink: 0;
	font-size: 13px; /* Make icon even smaller */
	/* transform: translateY(-1px); */ /* Removed vertical transform */
`

const NoteInput = styled.input`
	width: 100%;
	margin-top: 4px;
	padding: 3px 6px;
	box-sizing: border-box;
	background-color: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	border-radius: 2px;
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	outline: none;

	&::placeholder {
		color: var(--vscode-input-placeholderForeground);
	}

	&:focus {
		border-color: var(--vscode-focusBorder);
	}
`

interface QuotedMessagePreviewProps {
	text: string
	onDismiss: () => void
	isFocused?: boolean
	/** Note typed under the quote. The note input is only shown when `onNoteChange` is set. */
	note?: string
	onNoteChange?: (note: string) => void
	/** Called when Enter or Escape is pressed in the note input, e.g. to return focus to the composer. */
	onNoteDone?: () => void
	autoFocusNote?: boolean
	/** Drops the panel margins so the editor fits inside a popover. */
	compact?: boolean
}

const QuotedMessagePreview: React.FC<QuotedMessagePreviewProps> = ({
	text,
	onDismiss,
	isFocused,
	note,
	onNoteChange,
	onNoteDone,
	autoFocusNote,
	compact,
}) => {
	const _cardClassName = `reply-card ${isFocused ? "reply-card--focused" : ""}`

	return (
		<PreviewContainer $compact={compact}>
			{/* Removed Label */}
			<ContentRow>
				<ReplyIcon className="codicon codicon-reply" />
				<div className="flex-1 min-w-0">
					<TextContainer title={text}>{text}</TextContainer>
					{onNoteChange && (
						<NoteInput
							aria-label="Note on this quote"
							autoFocus={autoFocusNote}
							onChange={(e) => onNoteChange(e.target.value)}
							onKeyDown={(e) => {
								if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
									e.preventDefault()
									onNoteDone?.()
								}
							}}
							placeholder="Add a note on this quote…"
							value={note ?? ""}
						/>
					)}
				</div>
				<DismissButton appearance="icon" aria-label="Dismiss quote" onClick={onDismiss}>
					<span className="codicon codicon-close" />
				</DismissButton>
			</ContentRow>
		</PreviewContainer>
	)
}

export default QuotedMessagePreview
