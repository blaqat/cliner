import { useState } from "react"
import { MENU_ICON_CLASS, MENU_ITEM_CLASS } from "@/components/common/menuStyles"
import type { useSettleAll } from "@/components/taskGroup/settleAll"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

interface TaskGroupRowMenuProps {
	title: string
	settleAll: ReturnType<typeof useSettleAll>
	/** Reports whether the menu is open, so the row can keep this button shown. */
	onOpenChange?: (open: boolean) => void
}

/** The inbox task row's `⋯` menu: Settle all / Unsettle all for the task's threads. */
export const TaskGroupRowMenu = ({ title, settleAll, onOpenChange }: TaskGroupRowMenuProps) => {
	const [open, setOpen] = useState(false)
	const settling = settleAll.plan.mode === "settle"
	const change = (next: boolean) => {
		setOpen(next)
		onOpenChange?.(next)
	}
	// The row is a button that opens the task; clicks and keys inside the menu (a portal that
	// still bubbles through React) must not reach it.
	const stop = (event: React.SyntheticEvent) => event.stopPropagation()
	return (
		<Popover onOpenChange={change} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={`Actions for ${title}`}
					className={cn(
						"absolute right-0 top-0 flex size-4.5 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description",
						"opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:bg-toolbar-hover hover:text-foreground motion-reduce:transition-none",
						"focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
						open && "opacity-100",
					)}
					data-testid="inbox-task-group-menu"
					onClick={stop}
					onKeyDown={stop}
					type="button">
					<span aria-hidden className="codicon codicon-ellipsis text-[14px]" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-40 p-1 motion-reduce:animate-none"
				onClick={stop}
				onKeyDown={stop}
				side="bottom">
				<div className="flex flex-col" role="menu">
					<button
						className={MENU_ITEM_CLASS}
						disabled={settleAll.disabled}
						onClick={() => {
							change(false)
							void settleAll.run()
						}}
						role="menuitem"
						type="button">
						<span aria-hidden className={cn(MENU_ICON_CLASS, settling ? "codicon-check-all" : "codicon-discard")} />
						{settling ? "Settle all" : "Unsettle all"}
					</button>
				</div>
			</PopoverContent>
		</Popover>
	)
}
