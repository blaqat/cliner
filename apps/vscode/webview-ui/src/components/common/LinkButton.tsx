import { forwardRef } from "react"
import { cn } from "@/lib/utils"

/** A button that reads as a text link (Open task, Show output, Dismiss). Inherits the font size. */
export const LinkButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
	({ className, ...props }, ref) => (
		<button
			className={cn(
				"inline cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-link hover:text-link-hover hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-default disabled:opacity-50 disabled:hover:no-underline",
				className,
			)}
			ref={ref}
			type="button"
			{...props}
		/>
	),
)
LinkButton.displayName = "LinkButton"
