// Bundled release notes for Settings > About > What's new. Newest first; nothing is fetched at runtime.
// Test builds roll up into the release they lead to until that release is called.

export interface ReleaseNote {
	/** Stable id for test ids and keys, e.g. "release-2". */
	id: string
	/** Shown as the heading, e.g. "Release 2". */
	title: string
	/** Builds this entry covers, e.g. "test builds fork.24–25". */
	builds?: string
	/** ISO date of the release, or of the latest build while it is still in test. */
	date?: string
	notes: string[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
	{
		id: "release-2",
		title: "Release 2",
		builds: "test builds fork.24–27",
		date: "2026-10-19",
		notes: [
			"Composer: ＋ menu (mentions, files, MCP, rules, scripts), a where pill (task, worktree, branch suggestion), separate model and effort chips, context ring and approvals shield",
			"Models page for saved configurations, and Profiles (a model and an effort under a name) for new threads (Ask/Act), subagents and text generation; existing defaults carry over",
			"Notebook: unified review of agent edits, edit pending notes, a history page, and Convert to rule, skill or workflow",
			"References: # notes from any task, thread: mentions the agent can search, and message links",
			"Toasts when background threads finish or need input; Back with a session history that Home clears",
			"Settle all threads in a task; threads waiting on their subagents get their own status",
			"Terminal environment variables, a .env file and PATH entries for every command Cline runs",
			"Scripts: saved commands with typed options, run by you or the agent, with per-script approval",
			"Worktrees: run a thread in a git or mm worktree, then bring its changes here",
			"Change walkthrough with stops, review notes and optional Generate",
			"⌘K / Ctrl+K search and ⌘S / Ctrl+S stash work while Cline is focused",
			"About page; settings writes are safe across multiple VS Code windows",
			"Pasted message links become hover tags that give the agent that message; Copy link works on every message",
			"Tool call output starts collapsed; long messages and answers show in full",
			"Fixes: Responses streams no longer hang after the response completes (stall timeout too); finished threads stay done after a reload; every History thread shows in the inbox",
		],
	},
	{
		id: "release-1",
		title: "Release 1",
		builds: "fork.1–23",
		date: "2026-10-14",
		notes: [
			"Inbox home with Active and Settled, background chats, settle, asides, steer and interject; threads strip and minimap",
			"Tasks and the notebook: tasks group threads, a task page, notes shared by every thread in a task, and a wrap-up review",
			"Tags: ticket, branch and label tags; threads inherit their task's tags; type branch:name",
			"Search across threads, tasks, notes and messages",
			"Subagents open as full thread views with live progress, access levels, approvals and Stop",
			"Ask mode replaces Plan mode and can't write files, even through the terminal; /ask and /act anywhere in a message",
			"Saved configurations with a provider allowlist; per-chat model and effort; full OpenAI Compatible settings, including Azure and the Responses API",
			"Context ring with cost and an approvals menu; quotes as inline tags; every workflow in a message expands",
			"McpServerStart hooks; open chats pick up MCP changes; hooks no longer run every turn",
			"Shortcuts use Ctrl on Windows and Linux",
			"Installs next to the Marketplace Cline as Cline (Fork)",
			"Fixes: large edits no longer freeze the UI, chat no longer jumps, inline images are capped, subagent token totals stay consistent",
		],
	},
]
