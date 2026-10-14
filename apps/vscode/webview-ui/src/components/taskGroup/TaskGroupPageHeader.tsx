import type React from "react"
import { Breadcrumb, type Crumb } from "@/components/chat/task-header/Breadcrumb"
import { useExtensionState } from "@/context/ExtensionStateContext"

interface TaskGroupPageHeaderProps {
	taskGroupId: string
	title: string
	/** The notebook page adds a `Notebook` level after the task. */
	notebook?: boolean
	/** Right-side actions (the task page's `⋯`). */
	children?: React.ReactNode
}

/** `‹ ⌂ / Task` (and `/ Notebook`) for the task pages, styled like the thread header. */
export const TaskGroupPageHeader = ({ taskGroupId, title, notebook, children }: TaskGroupPageHeaderProps) => {
	const { hideTaskGroupView, navigateToTaskGroup } = useExtensionState()
	const crumbs: Crumb[] = [
		{ id: "home", kind: "home", label: "Home", onSelect: hideTaskGroupView },
		{
			id: `task:${taskGroupId}`,
			kind: "task",
			label: title,
			onSelect: notebook ? () => navigateToTaskGroup(taskGroupId, "home") : undefined,
		},
		...(notebook ? [{ id: `notebook:${taskGroupId}`, kind: "thread" as const, label: "Notebook" }] : []),
	]
	return (
		<div className="px-4 pt-2 pb-1">
			<div
				className="flex h-7.5 items-center gap-1 rounded-xs border border-transparent pl-0.5 pr-1 bg-(--vscode-toolbar-hoverBackground)/40"
				data-testid="task-group-header">
				<Breadcrumb crumbs={crumbs} />
				{children && <div className="flex shrink-0 items-center gap-0.5">{children}</div>}
			</div>
		</div>
	)
}
