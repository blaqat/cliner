import { PaperclipIcon } from "lucide-react"
import { memo } from "react"
import { COMPOSER_ICON_BUTTON_CLASS } from "@/components/common/menuStyles"
import { cn } from "@/lib/utils"

export interface AttachButtonProps {
	onAddFiles: () => void
	/** The message already holds as many files and images as it can take. */
	disabled: boolean
	/** How many files and images one message can take, for the disabled reason. */
	max: number
}

/**
 * The composer's 📎: files and images only (typing @ mentions files, / runs commands). When the
 * message is full it stays focusable and says why, rather than going silent.
 */
const AttachButton = ({ onAddFiles, disabled, max }: AttachButtonProps) => {
	const label = disabled
		? `Can't attach more: a message takes up to ${max} files and images. Remove one to add another.`
		: "Attach files & images"
	return (
		<button
			aria-disabled={disabled || undefined}
			aria-label={label}
			className={cn(COMPOSER_ICON_BUTTON_CLASS, disabled && "cursor-not-allowed opacity-50 hover:bg-transparent")}
			data-testid="attach-button"
			onClick={() => {
				if (!disabled) onAddFiles()
			}}
			title={label}
			type="button">
			<PaperclipIcon aria-hidden size={13} />
		</button>
	)
}

export default memo(AttachButton)
