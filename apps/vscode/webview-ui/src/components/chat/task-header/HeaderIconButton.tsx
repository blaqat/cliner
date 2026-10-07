import { forwardRef } from "react"
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

/** A 22px codicon action in the compact task header, with a tooltip. */
export const HeaderIconButton = forwardRef<HTMLButtonElement, HeaderIconButtonProps>(
	({ icon, label, tooltip, className, children, ...props }, ref) => (
		<Tooltip>
			<TooltipContent className="px-2 py-1" side="bottom">
				{tooltip ?? label}
			</TooltipContent>
			<TooltipTrigger asChild>
				<button aria-label={label} className={cn(HEADER_ICON_BUTTON_CLASS, className)} ref={ref} type="button" {...props}>
					<span aria-hidden className={`codicon codicon-${icon} text-[14px]`} />
					{children}
				</button>
			</TooltipTrigger>
		</Tooltip>
	),
)
HeaderIconButton.displayName = "HeaderIconButton"
