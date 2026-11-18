import type { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import { sideThreadAnswerText, WRAP_UP_PROMPT } from "@shared/sideThreads"
import { memo } from "react"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { cn } from "@/lib/utils"

const ANSWER_SAYS = new Set(["text", "completion_result", "plan_completion_result"])
const ANSWER_ASKS = new Set(["plan_mode_respond", "followup"])
const NEEDS_YOU_ASKS = new Set(["tool", "command", "use_mcp_server", "use_subagents", "browser_action_launch"])

const TOOL_LABEL: Partial<Record<ClineSayTool["tool"], string>> = {
	readFile: "Read",
	listFilesTopLevel: "Listed",
	listFilesRecursive: "Listed",
	listCodeDefinitionNames: "Read definitions in",
	searchFiles: "Searched",
	editedExistingFile: "Edited",
	newFileCreated: "Created",
	fileDeleted: "Deleted",
	webFetch: "Fetched",
	webSearch: "Searched the web for",
}

function toolLine(message: ClineMessage): string | undefined {
	try {
		const tool = JSON.parse(message.text ?? "{}") as Partial<ClineSayTool> & { regex?: string; query?: string }
		if (!tool.tool) return undefined
		const target = tool.path ?? tool.regex ?? tool.query ?? ""
		return `${TOOL_LABEL[tool.tool] ?? tool.tool}${target ? ` ${target}` : ""}`
	} catch {
		return undefined
	}
}

/** A tool the side thread ran: "Read main thread", "Read src/a.ts". */
function mcpOrNamedTool(message: ClineMessage): string | undefined {
	const text = message.text ?? ""
	if (text.includes("read_main_thread")) return "Read main thread"
	if (text.includes("send_to_main_thread")) return "Sent a note to main"
	return toolLine(message)
}

const Row = ({ icon, children, tone }: { icon: string; children: React.ReactNode; tone?: "error" | "warning" }) => (
	<div
		className={cn(
			"flex min-w-0 items-center gap-1.5 text-[11.5px] text-description",
			tone === "error" && "text-error",
			tone === "warning" && "text-warning",
		)}>
		<span aria-hidden className={cn("codicon shrink-0 text-[12px]", `codicon-${icon}`)} />
		<span className="min-w-0 truncate">{children}</span>
	</div>
)

interface SideThreadTranscriptProps {
	messages: readonly ClineMessage[]
	running: boolean
	/** Offered when the side thread waits on an approval this light view can't give. */
	onOpenFull?: () => void
}

/**
 * The side thread's own rows, read-light: your messages, its answers, one line per tool, and
 * a pointer to the full view when it needs an approval. Main's copied history is left out.
 */
export const SideThreadTranscript = memo(({ messages, running, onOpenFull }: SideThreadTranscriptProps) => {
	const rows = messages.flatMap((message): React.ReactNode[] => {
		const key = `${message.ts}:${message.say ?? message.ask}`
		if (message.type === "say" && (message.say === "user_feedback" || message.say === "task")) {
			const text = message.text?.trim() === WRAP_UP_PROMPT ? "Wrap up" : message.text
			return [
				<div
					className="self-start rounded-xs border border-input-border bg-input-background px-2 py-1 text-[12px] whitespace-pre-wrap break-words"
					key={key}>
					{text}
				</div>,
			]
		}
		if (
			(message.type === "say" && ANSWER_SAYS.has(message.say ?? "")) ||
			(message.type === "ask" && ANSWER_ASKS.has(message.ask ?? ""))
		) {
			const text = sideThreadAnswerText(message)
			return text
				? [
						<div className="min-w-0 text-[12px]" key={key}>
							<MarkdownBlock compact markdown={text} showCursor={!!message.partial} />
						</div>,
					]
				: []
		}
		if (message.say === "tool" || message.say === "mcp_server_request_started" || message.say === "use_mcp_server") {
			const line = mcpOrNamedTool(message)
			return line
				? [
						<Row icon="tools" key={key}>
							{line}
						</Row>,
					]
				: []
		}
		if (message.say === "error" || message.ask === "api_req_failed" || message.say === "diff_error") {
			return [
				<Row icon="error" key={key} tone="error">
					{message.text?.split("\n")[0] || "Something went wrong"}
				</Row>,
			]
		}
		if (message.type === "ask" && NEEDS_YOU_ASKS.has(message.ask ?? "") && !message.partial) {
			return [
				<div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-warning" key={key}>
					<span aria-hidden className="codicon codicon-bell-dot shrink-0 text-[12px]" />
					<span className="min-w-0 flex-1 truncate">Needs you: approve it in its own view</span>
					{onOpenFull && (
						<button
							className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
							onClick={onOpenFull}
							type="button">
							Open
						</button>
					)}
				</div>,
			]
		}
		return []
	})
	return (
		<div className="flex flex-col gap-2" data-testid="side-thread-transcript">
			{rows}
			{running && !messages.at(-1)?.partial && (
				<Row icon="loading codicon-modifier-spin motion-reduce:animate-none">Thinking…</Row>
			)}
		</div>
	)
})
SideThreadTranscript.displayName = "SideThreadTranscript"
