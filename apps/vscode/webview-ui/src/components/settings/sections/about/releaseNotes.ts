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
		builds: "fork.24–39",
		date: "2026-10-28",
		notes: [
			"Composer: ＋ for mentions and files, MCP and rules/scripts buttons beside it, a workspace button (your workspace or a worktree, with a link to set worktrees up) and a task pill, separate model and effort chips, the approvals shield and a context ring; every composer menu scrolls in a short window",
			"Models page for saved configurations, and Profiles (a model and an effort under a name) for threads, subagents and text generation",
			"Notebook review of agent edits, a history page, and Convert to rule, skill or workflow; # notes, thread: mentions and message links as context",
			"Context and cost card: how full the window is with the auto-compact point, cost per model and for subagents, and Compact; the Compact pill stays as an icon on narrow rows",
			"Search shows when each result was last active, labels messages You or Agent with a From filter, and lists message matches after tasks, threads and notes",
			"Walkthroughs: review a thread's changes stop by stop with notes, optional Generate, and Open walkthrough on finished turns; the agent can also write one for changes that aren't local, like a GitLab merge request",
			"Walkthrough notes inside the diff (what the agent said before each edit, or Generate's why-notes), notes on any selection like quoting a message, reviewed stops fold as you go, and J/K/R/N/Esc keys",
			"Scripts with typed options, per-thread worktrees (git or mm) whose menu says where the changes stand and copies them or switches your workspace to the branch, and terminal environment variables, .env and PATH for every command",
			"Asides group under the aside they came from; a task's name lives in the breadcrumb; links in a sent message open the linked message",
			"Toasts for background threads, Back history, Settle all on tasks or any one thread from home or the task page (active threads listed first), a waiting-on-subagents status, and ⌘K search / ⌘S stash while Cline is focused",
			"Fixes: no more endless Thinking… (Responses streams end on completion, Escape no longer cancels, a watchdog flags stuck turns); finished threads stay done after reload; every History thread shows in the inbox; asides follow their thread into a task; settings writes and the prompt stash are safe across windows; shortcuts follow the OS you're on; walkthroughs ignore Windows line endings",
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
