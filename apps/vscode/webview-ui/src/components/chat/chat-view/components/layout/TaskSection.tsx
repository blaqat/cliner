import { ClineMessage } from "@shared/ExtensionMessage"
import React from "react"
import TaskHeader from "@/components/chat/task-header/TaskHeader"
import { MessageHandlers } from "../../types/chatTypes"
import type { LineageRow } from "../../utils/threadUtils"

interface TaskSectionProps {
	task: ClineMessage
	messageHandlers: MessageHandlers
	onOpenSubagentPreview?: (row: LineageRow) => void
	/** Opens the task page from the breadcrumb. TODO(task-notebook phase 5): wire to the task page navigation. */
	onOpenTaskGroup?: (taskGroupId: string) => void
}

/**
 * Task section shown when there's an active task
 * Includes the task header and manages task-specific UI
 */
export const TaskSection: React.FC<TaskSectionProps> = ({ task, messageHandlers, onOpenSubagentPreview, onOpenTaskGroup }) => {
	return (
		<TaskHeader
			onClose={messageHandlers.handleTaskCloseButtonClick}
			onOpenSubagentPreview={onOpenSubagentPreview}
			onOpenTaskGroup={onOpenTaskGroup}
			task={task}
		/>
	)
}
