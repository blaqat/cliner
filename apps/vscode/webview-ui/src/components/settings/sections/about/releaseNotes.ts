// Bundled release notes for Settings > About > What's new. Newest first. Add an entry per fork release;
// nothing is fetched at runtime.

export interface ReleaseNote {
	/** Fork tag such as "4.1.22-fork.17". */
	version: string
	/** ISO date of the tag. */
	date?: string
	notes: string[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
	{
		version: "4.1.22-fork.25",
		date: "2026-10-19",
		notes: [
			"Model and effort are two separate composer chips again",
			"Settings: a Models page for saved configurations, and a Profiles page (a model and an effort under a name) for Thread, Subagents and Text generation",
			"Existing Ask/Act and feature defaults are carried over into profiles automatically",
			"About is a plain bulleted list",
			"UI pass: new settings, menus, worktree, script, walkthrough and notebook UI use Cline's shared components",
			"Settings writes are safe across multiple VS Code windows",
		],
	},
	{
		version: "4.1.22-fork.24",
		date: "2026-10-17",
		notes: [
			"⌘K / Ctrl+K no longer starts a VS Code chord while Cline is focused",
			"Suggests the task for your checked-out branch",
			"Notebook review and history pages, with Convert to rule, skill or workflow",
			"# mentions notes from any task; thread: mentions threads; message links",
			"Toasts for background threads, and Back with a session history",
			"New composer: ＋ menu, where pill, and one pill for model and effort",
			"Profiles page with Ask/Act defaults, subagent profiles and thread titles",
			"Terminal environment variables for every command Cline runs",
			"Worktrees: run a thread in a git or mm worktree",
			"Change walkthrough with notes you can send back to the thread",
			"Scripts: saved commands with typed options",
		],
	},
	{
		version: "4.1.22-fork.23",
		date: "2026-10-14",
		notes: ["Type branch:name to add a branch tag"],
	},
	{
		version: "4.1.22-fork.22",
		date: "2026-10-14",
		notes: ["Active tasks sort among threads by last activity"],
	},
	{
		version: "4.1.22-fork.21",
		date: "2026-10-14",
		notes: [
			"Tag row on threads, tag chips in the inbox and a quick branch tag; threads inherit their task's tags",
			"Settled tasks leave the active inbox; a task shows as soon as you send; task timeline view",
		],
	},
	{
		version: "4.1.22-fork.20",
		date: "2026-10-13",
		notes: ["The first message is always a chat bubble; editing a message keeps the thread"],
	},
	{
		version: "4.1.22-fork.19",
		date: "2026-10-13",
		notes: [
			"Tasks and the notebook: task groups on home, a task page, a notebook page, a notebook tool for the agent and a wrap-up review",
			"Search across threads, tasks, notes and messages",
			"Ask mode can no longer write files through the terminal, including through wrappers, xargs, find or parallel",
			"Inbox rows take their time from subthreads and subagents; the # menu follows the open thread",
		],
	},
	{
		version: "4.1.22-fork.18",
		date: "2026-10-08",
		notes: ["Subagent token totals stay consistent across reload and cancel"],
	},
	{
		version: "4.1.22-fork.17",
		date: "2026-10-08",
		notes: ["Subagents show live progress and actionable decisions, and open while running"],
	},
	{
		version: "4.1.22-fork.16",
		date: "2026-10-08",
		notes: [
			"Inline chat images are capped at 280px tall",
			"Subagent thread views, /ask and /act, MCP start hooks, saved configurations, the context ring and background chats, together",
		],
	},
	{
		version: "4.1.22-fork.15",
		date: "2026-10-07",
		notes: ["Large edit previews, diffs and patches no longer freeze the UI"],
	},
	{
		version: "4.1.22-fork.14",
		date: "2026-10-07",
		notes: [
			"Context ring with cost and an approvals menu in the composer",
			"Compact header and a subagent panel with Stop; stopping a subagent lets its parent continue",
			"/ask and /act work anywhere in a message; every workflow in a message expands",
			"Ask-mode MCP tools follow your MCP auto-approve setting",
		],
	},
	{
		version: "4.1.22-fork.13",
		date: "2026-10-05",
		notes: ["Subagents open as full thread views"],
	},
	{
		version: "4.1.22-fork.12",
		date: "2026-10-03",
		notes: ["McpServerStart hook type replaces per-server start hooks", "Quotes appear as inline tags in the composer"],
	},
	{
		version: "4.1.22-fork.11",
		date: "2026-10-02",
		notes: [
			"Model and effort at the bottom are per-chat; open chats pick up MCP changes",
			"Closing a running chat keeps it; start chats in the background",
			"Subagent settings; /ask and /act switch mode",
			"Hooks stop running on every turn; large rows no longer make chat jump",
		],
	},
	{
		version: "4.1.22-fork.10",
		date: "2026-09-30",
		notes: [
			"Shortcuts use Ctrl on Windows and Linux",
			"Interjected prompts never reappear in the queue; each model's context window is respected",
			"Chat times show last activity; the minimap uses the chat's own block colors",
		],
	},
	{
		version: "4.1.22-fork.9",
		date: "2026-09-30",
		notes: ["Azure deployment URLs on any host use the Responses API"],
	},
	{
		version: "4.1.22-fork.8",
		date: "2026-09-30",
		notes: ["The model picker shows the focused chat's live model and keeps queued switches"],
	},
	{
		version: "4.1.22-fork.7",
		date: "2026-09-30",
		notes: ["Reopened chats restore the configuration they last used"],
	},
	{
		version: "4.1.22-fork.6",
		date: "2026-09-30",
		notes: ['OpenAI Compatible: "none" effort, Azure Responses and clearer HTTP errors'],
	},
	{
		version: "4.1.22-fork.5",
		date: "2026-09-30",
		notes: [
			"Turn-based minimap and scroll-to-bottom",
			"Default reasoning effort per saved configuration",
			"The settled inbox section pages and collapses",
		],
	},
	{
		version: "4.1.22-fork.4",
		date: "2026-09-30",
		notes: ["OpenAI Compatible uses the Responses API when selected"],
	},
	{
		version: "4.1.22-fork.3",
		date: "2026-09-30",
		notes: ["Installs next to the Marketplace Cline as Cline (Fork)"],
	},
	{
		version: "4.1.22-fork.2",
		date: "2026-09-30",
		notes: ["Full OpenAI Compatible settings in the configuration editor"],
	},
	{
		version: "4.1.22-fork.1",
		date: "2026-09-30",
		notes: [
			"Inbox home, threads strip, minimap and motion",
			"Saved configurations with a provider allowlist",
			"Ask mode, subagent access levels, background sessions, settle, asides and interject",
		],
	},
]
