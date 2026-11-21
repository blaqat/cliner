import { lstatSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { ClineAskQuestion, ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"

/**
 * Which approvals an automation's Act step gets without asking: reading and editing files inside the
 * run's own worktree. That worktree is a throwaway branch made for this step, so a change there is
 * reviewed later (Ready for review › Walk through) rather than one by one. Nothing else is approved
 * for you: commands (they can reach anything), MCP tools, the browser, and any path outside the
 * worktree still ask, exactly as they would in a thread you started yourself.
 */
const READ_TOOLS = new Set(["read_files", "read_file", "list_files", "list_code_definition_names", "search_files"])
const EDIT_TOOLS = new Set(["editor"])

function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Capture the worktree identity at approval, then recheck every existing component at execution. */
export function worktreePathGuard(worktree: string): (candidate: string) => void {
	const root = realpathSync.native(worktree)
	const identity = statSync(root)
	if (!identity.isDirectory()) throw new Error("The automation worktree is missing.")
	return (candidate) => {
		const currentRoot = statSync(worktree)
		if (realpathSync.native(worktree) !== root || currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino)
			throw new Error("The automation worktree changed. Retry the tool to ask for approval.")
		const resolved = path.resolve(worktree, candidate)
		const volume = path.parse(resolved).root
		let current = volume
		let entered = false
		for (const component of path.relative(volume, resolved).split(path.sep)) {
			current = path.join(current, component)
			let real: string
			try {
				real = realpathSync.native(current)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				// A dangling symlink is not a new file or directory.
				try {
					lstatSync(current)
					throw new Error("Unresolved symlink in automation path.")
				} catch (missing) {
					if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing
				}
				if (entered) continue // New paths inherit their nearest existing ancestor's location.
				throw new Error("Automation path is outside its worktree.")
			}
			if (inside(root, real)) entered = true
			else if (entered) throw new Error("Automation path leaves its worktree through a symlink.")
		}
		if (!entered) throw new Error("Automation path is outside its worktree.")
	}
}

/** Every path a read or edit tool call names; undefined when its input can't be read (so it asks). */
export function toolPaths(toolName: string, input: unknown): string[] | undefined {
	const value = typeof input === "string" ? safeParse(input) : input
	if (toolName === "search_codebase") return [] // Searches only the thread's own folder.
	if (toolName === "apply_patch") {
		const patch = typeof value === "string" ? value : (value as { input?: unknown } | undefined)?.input
		if (typeof patch !== "string") return undefined
		const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) =>
			(match[1] ?? match[2]).trim(),
		)
		return paths.length ? paths : undefined
	}
	if (!READ_TOOLS.has(toolName) && !EDIT_TOOLS.has(toolName)) return undefined
	const collect = (entry: unknown): string[] => {
		if (typeof entry === "string") return [entry]
		if (Array.isArray(entry)) return entry.flatMap(collect)
		if (entry && typeof entry === "object") {
			const record = entry as Record<string, unknown>
			return [record.path, record.file_path, record.files, record.file_paths, record.paths]
				.filter((field) => field !== undefined)
				.flatMap(collect)
		}
		return []
	}
	const paths = collect(value)
	return paths.length ? paths : undefined
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

/** True when the call only reads or edits files inside `worktree`. */
export function staysInWorktree(toolName: string, input: unknown, worktree: string): boolean {
	const paths = toolPaths(toolName, input)
	if (!paths) return false
	try {
		const guard = worktreePathGuard(worktree)
		paths.forEach(guard)
		return true
	} catch {
		return false
	}
}

function shorten(text: string, max = 60): string {
	const line = text.replace(/\s+/g, " ").trim()
	return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const TOOL_WORDS: Partial<Record<ClineSayTool["tool"], string>> = {
	editedExistingFile: "Approve an edit to",
	newFileCreated: "Approve a new file:",
	fileDeleted: "Approve deleting",
	readFile: "Approve reading",
	listFilesTopLevel: "Approve listing",
	listFilesRecursive: "Approve listing",
	searchFiles: "Approve a search in",
}

/** What a waiting thread needs from the user, from its pending approval or question. */
export function describeDecision(message: ClineMessage | undefined): string | undefined {
	if (!message || message.type !== "ask") return undefined
	switch (message.ask) {
		case "command":
			return `Approve a command: ${shorten(message.text ?? "")}`
		case "use_mcp_server":
			return "Approve an MCP tool"
		case "browser_action_launch":
			return "Approve opening the browser"
		case "use_subagents":
			return "Approve starting subagents"
		case "followup": {
			const question = (safeParse(message.text ?? "") as ClineAskQuestion | undefined)?.question
			return question ? `Answer: ${shorten(question)}` : "Answer its question"
		}
		case "tool": {
			const tool = safeParse(message.text ?? "") as ClineSayTool | undefined
			const words = tool?.tool ? TOOL_WORDS[tool.tool] : undefined
			if (words && tool?.path) return `${words} ${shorten(tool.path, 48)}`
			return "Approve a tool call"
		}
		default:
			return undefined
	}
}
