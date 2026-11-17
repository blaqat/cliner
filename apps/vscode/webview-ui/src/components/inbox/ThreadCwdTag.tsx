import { FolderIcon } from "lucide-react"
import { cwdBasename, isTaskCwdOutsideWorkspace } from "@/components/chat/task-header/TaskWorkingDirectoryBadge"
import { useExtensionState } from "@/context/ExtensionStateContext"

/**
 * The thread header's working-directory callout, for a row in a list: the folder a thread runs in when
 * it's outside what's open here. Quieter than the header's, since a list can be full of them.
 */
export const ThreadCwdTag = ({ cwd }: { cwd?: string }) => {
	const { workspaceRoots, platform } = useExtensionState()
	if (!cwd || !isTaskCwdOutsideWorkspace(cwd, workspaceRoots, platform)) return null
	const path = cwd.trim()
	return (
		<span
			className="inline-flex min-w-0 max-w-28 shrink-0 items-center gap-1 rounded-full border border-solid border-editor-group-border px-1.5 text-[10px] leading-4 text-description"
			data-testid="thread-cwd-tag"
			title={`This thread's working directory is ${path}, which is outside the current workspace. Cline reads and edits files and runs commands there.`}>
			<FolderIcon className="shrink-0" size={10} />
			<span className="ph-no-capture min-w-0 truncate">{cwdBasename(path, platform)}</span>
		</span>
	)
}
