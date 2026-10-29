import type React from "react"
import { Breadcrumb, type Crumb } from "@/components/chat/task-header/Breadcrumb"
import { useOneView } from "@/components/oneView/OneViewContext"
import { useExtensionState } from "@/context/ExtensionStateContext"

interface TaskGroupPageHeaderProps {
	taskGroupId: string
	title: string
	/** The notebook page adds a `Notebook` level after the task. */
	notebook?: boolean
	/** Right-side actions (the task page's `⋯`). */
	children?: React.ReactNode
	/** Renames the task from its crumb (✎ or double-click), like a thread's title. */
	onRename?: (title: string) => void
	/** Bumped to start that rename from the ⋯ menu. */
	renameSignal?: number
}

/** `‹ ⌂ / Task` (and `/ Notebook`) for the task pages, styled like the thread header. */
export const TaskGroupPageHeader = ({
	taskGroupId,
	title,
	notebook,
	children,
	onRename,
	renameSignal,
}: TaskGroupPageHeaderProps) => {
	const { hideTaskGroupView, navigateToTaskGroup } = useExtensionState()
	// One view: the list is home, so no Home crumb; its list toggle leads the header.
	const oneView = useOneView()
	const crumbs: Crumb[] = [
		...(oneView.enabled ? [] : [{ id: "home", kind: "home" as const, label: "Home", onSelect: hideTaskGroupView }]),
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
				{oneView.listToggle}
				<Breadcrumb crumbs={crumbs} onRename={notebook ? undefined : onRename} renameSignal={renameSignal} />
				{children && <div className="flex shrink-0 items-center gap-0.5">{children}</div>}
			</div>
		</div>
	)
}
