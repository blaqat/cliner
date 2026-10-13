import type { TaskTagKind } from "@shared/task-groups"
import { cn } from "@/lib/utils"

const KIND_STYLE: Record<TaskTagKind, { icon: string; className: string }> = {
	ticket: {
		icon: "issues",
		className: "text-(--vscode-charts-blue) border-(--vscode-charts-blue)/45 bg-(--vscode-charts-blue)/10",
	},
	branch: {
		icon: "git-branch",
		className: "text-(--vscode-charts-green) border-(--vscode-charts-green)/45 bg-(--vscode-charts-green)/10",
	},
	label: {
		icon: "tag",
		className: "text-(--vscode-charts-yellow) border-(--vscode-charts-yellow)/45 bg-(--vscode-charts-yellow)/10",
	},
}

interface TaskTagChipProps {
	kind: TaskTagKind
	value: string
	/** Dashed and unfilled: found or suggested, not (yet) a tag. */
	detected?: boolean
	/** Renders the chip as a "＋" button (e.g. the suggested branch). */
	onAdd?: () => void
	/** Adds a × button that removes the tag. */
	onRemove?: () => void
	/** Hides the × until the chip is hovered or focused. */
	revealRemove?: boolean
	className?: string
}

/** Compact tag pill for task groups and threads: ticket, branch or label. */
export const TaskTagChip = ({ kind, value, detected, onAdd, onRemove, revealRemove, className }: TaskTagChipProps) => {
	const style = KIND_STYLE[kind]
	const classes = cn(
		"inline-flex h-4 max-w-40 shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-[10.5px] leading-none whitespace-nowrap",
		style.className,
		(detected || onAdd) && "border-dashed bg-transparent",
		revealRemove && "group/chip",
		className,
	)
	const content = (
		<>
			{onAdd && <span aria-hidden>＋</span>}
			<span aria-hidden className={`codicon codicon-${style.icon} text-[10px]!`} />
			<span className="truncate">{value}</span>
		</>
	)
	if (onAdd) {
		return (
			<button
				aria-label={`Add ${kind} tag ${value}`}
				className={cn(classes, "cursor-pointer hover:border-solid")}
				data-testid="task-tag-chip"
				onClick={onAdd}
				type="button">
				{content}
			</button>
		)
	}
	return (
		<span className={classes} data-kind={kind} data-testid="task-tag-chip" title={value}>
			{content}
			{onRemove && (
				<button
					aria-label={`Remove tag ${value}`}
					className={cn(
						"ml-0.5 cursor-pointer border-0 bg-transparent p-0 leading-none text-inherit opacity-60 hover:opacity-100 focus-visible:opacity-100",
						revealRemove &&
							"opacity-0 transition-opacity duration-150 group-hover/chip:opacity-60 group-focus-within/chip:opacity-60 motion-reduce:transition-none",
					)}
					onClick={onRemove}
					type="button">
					×
				</button>
			)}
		</span>
	)
}
