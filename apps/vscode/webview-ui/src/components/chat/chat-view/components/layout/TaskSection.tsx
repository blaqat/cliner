import { ClineMessage } from "@shared/ExtensionMessage"
import React from "react"
import TaskHeader from "@/components/chat/task-header/TaskHeader"
import { MessageHandlers } from "../../types/chatTypes"
import type { LineageRow } from "../../utils/threadUtils"

interface TaskSectionProps {
	task: ClineMessage
	messageHandlers: MessageHandlers
	onOpenSubagentPreview?: (row: LineageRow) => void
}

/**
 * Task section shown when there's an active task
 * Includes the task header and manages task-specific UI
 */
export const TaskSection: React.FC<TaskSectionProps> = ({ task, messageHandlers, onOpenSubagentPreview }) => {
	return (
		<TaskHeader
			onClose={messageHandlers.handleTaskCloseButtonClick}
			onOpenSubagentPreview={onOpenSubagentPreview}
			task={task}
		/>
	)
}
