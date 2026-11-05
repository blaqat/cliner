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
		id: "release-3",
		title: "Release 3",
		builds: "fork.39–61",
		date: "2026-11-05",
		notes: [
			"Models replace Profiles, and your saved setups move over on their own: add a connection and it saves itself, enter several model IDs at once or tick them, share defaults across a connection, duplicate a model or turn one off. Every provider is offered, and removing a model or connection is one confirmation",
			"Settings is seven short pages (Models, Agent, Subagents, Tools, Layout, Data & privacy, About) with one search, roomier rows in outlined groups, and a Changed chip that lists and resets what isn't the default",
			"One model selector everywhere: model and level side by side, with Make this the default in the composer's menu. Background text has its own model, and Subagents have one page for their model, level, cap, access and whether they can block the parent",
			"Gateways and Azure: one base URL can serve many models, an API version you set goes on every request, a blank temperature sends none, and custom headers stay as text unless you lock one. Images and tools are Yes or No, and No unless the catalog knows the model, and OpenAI's built-in tools only go to OpenAI's own servers",
			"One view (beta, Settings › Layout): your threads beside the chat or as tabs across the top, with status, the last line and in-place search",
			"Search chooses what to look in: Threads, Messages, Notes or Tags, plus state and a date range in one view. Typing #tag filters by tag",
			"Simpler composer: the buttons sit inside the box, Ask/Act is a sliding switch, and one menu holds models and efforts with the auto-approvals as icon tiles. While a turn runs, the button steers and interject is keys only. New chats pick the workspace and task under the composer",
			"Subagents run alongside their parent: it keeps working, can message, check on or cancel them, and gets their results as they land. Your messages and Stop no longer cancel them, and they can't start subagents of their own",
			"Stash threads and tasks you'll come back to, and a row's Stash and Settle replace its time. Home orders by your last message, and thread lists name the folder of a thread running outside what's open",
			"Walkthroughs can include Cline's review notes (Fix, Reply or Dismiss each one), diffs are syntax highlighted, and in one view a walkthrough keeps your list beside it",
			"MCP servers and Rules & workflows open from the title bar, and Layout is a picture to pick",
			"Fixes: your models and settings no longer disappear when main Cline is installed too, because this build keeps its own copy; Ask/Act always switches and only sending needs a model; a thread whose model was removed uses your default; ticket numbers in a first message become tags; deleting the thread you're in goes back to its task or home; Reset removes saved keys and sign-ins; walkthroughs on Windows show only real edits",
		],
	},
	{
		id: "release-2",
		title: "Release 2",
		builds: "fork.24–38",
		date: "2026-10-22",
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
			"Fixes: no more endless Thinking… (Responses streams end on completion, Escape no longer cancels, a watchdog flags stuck turns); finished threads stay done after reload; every History thread shows in the inbox; asides follow their thread into a task; settings writes and the prompt stash are safe across windows; shortcuts follow the OS you're on",
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
