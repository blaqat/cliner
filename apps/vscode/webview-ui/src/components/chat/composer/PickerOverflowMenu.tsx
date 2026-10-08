import { EllipsisIcon } from "lucide-react"
import type React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/** Narrow composer rows fold the effort and approvals pickers into this "…" menu. */
const PickerOverflowMenu = ({ children }: { children: React.ReactNode }) => (
	<Popover>
		<PopoverTrigger asChild>
			<button
				aria-label="More options"
				className="flex items-center justify-center h-5 px-1 shrink-0 rounded-xs border-0 bg-transparent text-description cursor-pointer hover:bg-toolbar-hover hover:text-foreground"
				data-testid="picker-overflow-button"
				title="More options"
				type="button">
				<EllipsisIcon size={13} />
			</button>
		</PopoverTrigger>
		<PopoverContent
			align="start"
			className="w-auto max-w-[calc(100vw-16px)] flex flex-col items-start gap-0.5 p-1"
			data-testid="picker-overflow-menu"
			side="top">
			{children}
		</PopoverContent>
	</Popover>
)

export default PickerOverflowMenu
