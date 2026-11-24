import { forwardRef, useLayoutEffect, useRef, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface HeaderIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	/** Codicon name without the `codicon-` prefix. */
	icon: string
	label: string
	/** Tooltip text; defaults to the label. */
	tooltip?: React.ReactNode
}

export const HEADER_ICON_BUTTON_CLASS =
	"relative flex size-5.5 shrink-0 items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description cursor-pointer transition-colors duration-150 hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"

/** How long after its menu closes the button ignores the focus the menu hands back, rather than showing its tooltip. */
const AFTER_MENU_MS = 500

/**
 * A 22px codicon action in the compact task header, with a tooltip. As a menu trigger, the tooltip
 * stays hidden while the menu is open and when the closing menu returns focus to the button, so it
 * never covers what the menu just opened (a confirm under the header, say).
 */
export const HeaderIconButton = forwardRef<HTMLButtonElement, HeaderIconButtonProps>(
	({ icon, label, tooltip, className, children, ...props }, ref) => {
		const expanded = props["aria-expanded"] === true || props["aria-expanded"] === "true"
		const [open, setOpen] = useState(false)
		const menuClosedAt = useRef(0)
		const wasExpanded = useRef(expanded)
		// Before the menu's focus return (which runs after this commit), so that focus is recognized.
		useLayoutEffect(() => {
			if (wasExpanded.current && !expanded) menuClosedAt.current = Date.now()
			wasExpanded.current = expanded
			if (expanded) setOpen(false)
		}, [expanded])
		return (
			<Tooltip
				onOpenChange={(next) => setOpen(next && !expanded && Date.now() - menuClosedAt.current > AFTER_MENU_MS)}
				open={open && !expanded}>
				<TooltipContent className="px-2 py-1" side="bottom">
					{tooltip ?? label}
				</TooltipContent>
				<TooltipTrigger asChild>
					<button
						aria-label={label}
						className={cn(HEADER_ICON_BUTTON_CLASS, className)}
						ref={ref}
						type="button"
						{...props}>
						<span aria-hidden className={`codicon codicon-${icon} text-[14px]`} />
						{children}
					</button>
				</TooltipTrigger>
			</Tooltip>
		)
	},
)
HeaderIconButton.displayName = "HeaderIconButton"
