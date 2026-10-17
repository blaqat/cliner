import { EmptyRequest } from "@shared/proto/cline/common"
import { AllTaskNotes, TaskGroupNotes } from "@shared/proto/cline/task_group"
import { Controller } from ".."
import { notebookNoteMetaToProto } from "./conversions"

/**
 * Lists notebook notes across every task group for the composer's `#` menu.
 * The current task's group comes first server-side only by coincidence —
 * the webview re-ranks against the composer's actual task.
 */
export async function listAllNotes(controller: Controller, _request: EmptyRequest): Promise<AllTaskNotes> {
	const groups = await controller.listAllNotes()
	return AllTaskNotes.create({
		groups: groups.map((group) =>
			TaskGroupNotes.create({
				taskGroupId: group.taskGroupId,
				taskGroupTitle: group.taskGroupTitle,
				notes: group.notes.map(notebookNoteMetaToProto),
			}),
		),
	})
}
