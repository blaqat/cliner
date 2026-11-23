import { forwardRef, useId } from "react"
import { cn } from "@/lib/utils"
import { MENU_ICON_CLASS, MENU_ITEM_CLASS } from "./menuStyles"

interface MenuItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
	/** Codicon name without the `codicon-` prefix. */
	icon: string
	/** Extra classes for the icon, e.g. a spinning loader. */
	iconClassName?: string
	label: React.ReactNode
	/** Right-aligned extra: a shortcut ("/skill"), a chevron for a submenu. */
	hint?: React.ReactNode
	/**
	 * Why the row can't be used right now, shown under the label while it's disabled, so a
	 * greyed-out row never leaves the user guessing.
	 */
	reason?: string
	/** A row that deletes or discards: error-colored, and the menu sets it apart below a divider. */
	destructive?: boolean
}

/**
 * One row of a popover menu (task ⋯, thread ⋯): the shared 24px row, one icon size, a label that
 * stays on one line, and a reason under a disabled row.
 */
export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
	({ icon, iconClassName, label, hint, reason, destructive, disabled, className, ...props }, ref) => {
		const reasonId = useId()
		const explained = !!disabled && !!reason
		return (
			<button
				aria-describedby={explained ? reasonId : undefined}
				className={cn(
					MENU_ITEM_CLASS,
					"whitespace-nowrap",
					destructive && "text-error",
					// The label fades, the reason under it stays readable.
					explained && "h-auto min-h-6 items-start py-1 disabled:opacity-100",
					className,
				)}
				disabled={disabled}
				ref={ref}
				role="menuitem"
				type="button"
				{...props}>
				<span
					aria-hidden
					className={cn(MENU_ICON_CLASS, `codicon-${icon}`, iconClassName, explained && "mt-px opacity-50")}
				/>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className={cn("truncate", explained && "opacity-50")}>{label}</span>
					{/* Hidden from the row's name; read as its description instead. */}
					{explained && (
						<span aria-hidden className="text-[11px] leading-4 whitespace-normal text-description" id={reasonId}>
							{reason}
						</span>
					)}
				</span>
				{hint && <span className={cn("shrink-0 text-[11px] text-description", explained && "opacity-50")}>{hint}</span>}
			</button>
		)
	},
)
MenuItem.displayName = "MenuItem"
