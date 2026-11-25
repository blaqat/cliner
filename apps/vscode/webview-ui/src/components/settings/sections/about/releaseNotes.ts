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
		id: "release-4",
		title: "Release 4",
		builds: "test builds fork.64–73",
		date: "2026-11-25",
		notes: [
			"Now built on Cline 4.1.26 (was 4.1.22), with its fixes: GPT-6 works on Azure and OpenAI-compatible endpoints, reasoning levels fit what each model accepts and Off works everywhere, a provider error mid-reply is retried, long local-model requests no longer time out after 5 minutes, and a reply that ends without a reason is continued",
			"Also from 4.1.26: switching Ask/Act while a thread starts keeps your first message, a thread open in two apps, or in one that closes mid-reply, no longer gets stuck, attachments reach the model when you answer Cline's question, symlinked rules and .claude/skills load, disabled rules stay off, and running a command no longer moves focus to the terminal",
			"Automations: build one from steps (prompt threads with their own models, threads that run together, a step that waits for your pick, find or open a task for a ticket) or describe it and Cline drafts it; start it with /name. The bar above the composer says where the run is and what needs you, with Go to it; the task page has the steps and replies; Ready for review says what to look at. They replace Scripts",
			"A run that fails can be retried from the failed step or an earlier one, or run again, keeping finished work, and each failure says what to fix with a link or a button (Open folder…, Initialize git here). Before a run starts Cline checks its worktrees and models. Edits inside a run's own worktree don't ask; commands and anything outside it still do. Also a per-automation cost limit and Save as an automation on any task",
			"Automation steps can declare named outputs that the model records and later steps use ({{steps.research.plan}}), each one openable and copyable in the run; a step that ends without one waits with Ask it again or Continue without. An output can also be saved as a task note without asking, and an automation can keep its threads' task notes automatically (About you and skills still ask). Change with a prompt… edits an automation and shows the change as a diff to Keep or Drop. A run folds even while it's running, still showing its current step, Stop and anything waiting on you, and each step folds too",
			"A This thread panel, opened from a button in the thread header, shows the thread's branch and changes, its side threads and subagents, its notes, and context and cost: beside the chat when there's room, over it when there isn't (click anywhere else to close); choose which sections show",
			"Side threads (/side, kept, beside the main thread when there's room) and side questions (/btw, answered in a card above the composer that closes when you move on, or Keep as side thread); a side thread can read the main thread and send it a note, and Wrap up drafts one for you",
			"Skillsets: share skills and workflows as one .skillset.zip; hold Shift and drop one on Cline (or Skills › Add skillset…) and Cline eats it. New items arrive switched off with anything that runs code marked, and Remove all takes a set back out",
			"Make this a skill: ask, type /skill, or pick Make a skill… from a thread's menu, and the draft lands in the turn's review row to edit, make a workflow, and Keep",
			"Notes: one review row per turn for notes, About you and skills, with one-click Keep; About you holds lasting things about you that every thread reads, and work notes in a thread outside a task get an offer to file it; a Preview / Edit editor for notes, rules, workflows and skills",
			"Walkthroughs: Ask why about any lines (hover a line for Ask, select lines, turn a line note into a question with Ask instead, or ask about one of Cline's review notes, which sends the note along); the answer appears under them, using the model set in Settings (by default the one that made the walkthrough), and can continue as a side thread",
			"Models: each connection shows what it sends, apart from its models; pasting a URL or curl fills the form, and picking which OpenAI model a deployment is fills its prices and limits",
			"Thread lists in one view show each thread's tags under its title, and new thread titles name what the thread is about rather than echoing the first words",
			"Faster: settling or stashing a whole task is instant and syncs to your other windows, ＋ always takes you home at once, the task page shows new threads as they start, and threads working in the background no longer open files in your editor",
			"Workspaces: mm workspaces with git submodules work (submodules are set up all the way down), changes inside nested submodules show in the diff, are copied home and warned about before removal, and Cline asks mm which modules a workspace has (mm modules --json), so it always agrees with mm. Turning worktrees on is one pick that saves at once, every off message names the setting that's off and links to it, and a folder with .mm.json or .mmrc offers Use mm. Worktrees work on Windows when VS Code spells the drive letter differently from git, a worktree gets only the submodules your workspace has set up (one you can't fetch is left unset instead of stopping everything), Settings shows the folder and config file mm runs with, and removing a worktree names any local submodule branch it would lose. A worktree that can't be made or read, or an mm.js too old to answer, says why and offers the fix",
			"Task worktrees: a task can own one worktree that all its threads share (pick New worktree for this task), while a thread can still take a private one for a separate attempt. Copy home, switch, undo and remove live on the task page, automation steps share the task's worktree by default, and restoring a checkpoint is refused where other threads would lose their edits",
			"Safer removal: removing a worktree, settling, upstream's Worktrees view, deleting a task and mm free all check every Git repository inside it and warn, in plain words, about branches, stashes or commits that exist nowhere else and about unsaved editors; a warning only counts as confirmed if nothing changed since you saw it",
			"Delete a task with all its threads (or just the task) from ⋯ › Delete task…; it first lists what stops and what's lost, and removes nothing unless everything can go",
			"Automation arguments are chips in the composer, one field each (Tab between them); text or attachments under them are the run's context, given to every thread or only where {{context}} is; a For each step runs the following steps once per item, each in its own task, and retries only the items that didn't finish",
			"A proposed change to a workflow, skill or note opens on just what changed (long unchanged parts folded, the whole document one click away in a box that scrolls), and a one-line change to a file with Windows line endings or front matter no longer shows as the whole file replaced. Keep leaves the rest of the file byte for byte, so a switched-off skill stays off",
			"The minimap is now modelled on T3 Code's: one line per turn on the chat's right edge; hover for a preview, click to jump, scroll over it to scroll the chat. The chat follows a streaming reply instead of catching up when it ends, and the task and thread ⋯ menus say why an item is unavailable",
			"Fixes: Azure keys reach the model list and connection test, and API Management keys can go in their own header; accepting notes never fails on an older card; worktree settings show again in Settings › Tools (they were hidden behind an upstream rollout); a reply that comes back as reasoning only is asked for its answer once, then explained instead of ending silently; a retried or cut-off reply no longer leaves Thinking open or repeats it; reasoning a model sends as <think> tags shows as Thinking, not in the answer; subagent cost is counted once per batch; an edit whose real location is outside the thread's folder, such as through a symlink, always asks",
		],
	},
	{
		id: "release-3",
		title: "Release 3",
		builds: "fork.39–63",
		date: "2026-11-06",
		notes: [
			"Models replace Profiles, and your saved setups move over on their own: add a connection and it saves itself, enter several model IDs at once or tick them, share defaults across a connection, duplicate a model or turn one off. Every provider is offered, and removing a model or connection is one confirmation",
			"Settings is seven short pages (Models, Agent, Subagents, Tools, Layout, Data & privacy, About) with one search, roomier rows in outlined groups, and a Changed chip that lists and resets what isn't the default",
			"One model selector everywhere: model and level side by side, a click switches at once, with Make this the default in the composer's menu. Background text has its own model, and Subagents have one page for their model, level, cap, access and whether they can block the parent",
			"Gateways and Azure: one base URL can serve many models, an API version you set goes on every request, a blank temperature sends none, and custom headers stay as text unless you lock one. Images and tools are Yes or No, and No unless the catalog knows the model, and OpenAI's built-in tools only go to OpenAI's own servers",
			"One view (beta, Settings › Layout): your threads beside the chat or as tabs across the top, with status, the last line and in-place search",
			"Search chooses what to look in: Threads, Messages, Notes or Tags, plus state and a date range in one view. Typing #tag filters by tag",
			"Simpler composer: the buttons sit inside the box, Ask/Act is a sliding switch, and one menu holds models and efforts with the auto-approvals as icon tiles. While a turn runs, the button steers and interject is keys only. New chats pick the workspace and task under the composer",
			"Subagents run alongside their parent: it keeps working, can message, check on or cancel them, and gets their results as they land. Your messages and Stop no longer cancel them, and they can't start subagents of their own",
			"Stash threads and tasks you'll come back to, and a row's Stash and Settle replace its time. Home orders by your last message, and thread lists name the folder of a thread running outside what's open",
			"Walkthroughs can include Cline's review notes (Fix, Reply or Dismiss each one), diffs are syntax highlighted, and in one view a walkthrough keeps your list beside it",
			"MCP servers and Rules & workflows open from the title bar, and Layout is a picture to pick",
			"Fixes: your models and settings no longer disappear when main Cline is installed too, because this build keeps its own copy; Send no longer stays locked after a very quick reply; Ask/Act always switches and only sending needs a model; a thread whose model was removed uses your default; ticket numbers in a first message become tags; deleting the thread you're in goes back to its task or home; Reset removes saved keys and sign-ins; walkthroughs on Windows show only real edits",
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
