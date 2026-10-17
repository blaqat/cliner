// Copy for Settings > About. Edit the lists here; AboutPictures.tsx draws the pictures.

/** Upstream Cline release this fork is based on. Bump when rebasing onto a newer Cline. */
export const UPSTREAM_CLINE_VERSION = "4.1.22"

export type PictureKey =
	| "inbox"
	| "bg"
	| "interject"
	| "strip"
	| "quote"
	| "task"
	| "note"
	| "review"
	| "hist"
	| "convert"
	| "wrap"
	| "xnote"
	| "thread"
	| "link"
	| "tags"
	| "branch"
	| "ghost"
	| "search"
	| "sub"
	| "subacc"
	| "askcmd"
	| "askguard"
	| "cfg"
	| "pill"
	| "azure"
	| "plus"
	| "where"
	| "ring"
	| "wf"
	| "toast"
	| "back"
	| "aa"
	| "usedby"
	| "env"
	| "wt"
	| "wtmenu"
	| "walk"
	| "walknote"
	| "script"
	| "mcp"

export interface FeatureItem {
	text: string
	pictures: PictureKey[]
}

export interface FeatureGroup {
	id: string
	title: string
	items: FeatureItem[]
}

export const FEATURE_GROUPS: FeatureGroup[] = [
	{
		id: "threads",
		title: "Threads & inbox",
		items: [
			{ text: "Home inbox: Active and Settled; tasks and threads by last activity", pictures: ["inbox"] },
			{ text: "Background chats: closing a running chat keeps it running", pictures: ["bg"] },
			{ text: "Settle, asides, and interject into a running turn", pictures: ["interject"] },
			{ text: "Threads strip and a minimap of turns", pictures: ["strip"] },
			{ text: "Quote any message text into the composer", pictures: ["quote"] },
		],
	},
	{
		id: "tasks",
		title: "Tasks & notebook",
		items: [
			{ text: "Tasks group threads; a task page with its threads and notes", pictures: ["task"] },
			{ text: "Notes shared by every thread in a task; # mentions a note", pictures: ["note"] },
			{
				text: "Agent note edits arrive as a unified review; edit pending notes, Accept all or Discard all",
				pictures: ["review"],
			},
			{ text: "Note history: compare any version with the current one", pictures: ["hist"] },
			{ text: "Convert a note to a rule, skill or workflow", pictures: ["convert"] },
			{ text: "Wrap-up review when a task settles", pictures: ["wrap"] },
		],
	},
	{
		id: "references",
		title: "References",
		items: [
			{ text: "# mentions notes from any task", pictures: ["xnote"] },
			{ text: "thread: mentions any thread, including other tasks", pictures: ["thread"] },
			{ text: "Copy a message link; pasting it becomes a quote chip", pictures: ["link"] },
		],
	},
	{
		id: "tags",
		title: "Tags",
		items: [
			{ text: "Ticket, branch and label tags on tasks and threads", pictures: ["tags"] },
			{ text: "Type branch:name; threads inherit their task's tags", pictures: ["branch"] },
			{ text: "Suggests the task for your checked-out branch", pictures: ["ghost"] },
		],
	},
	{
		id: "search",
		title: "Search",
		items: [{ text: "⌘K / Ctrl+K across threads, tasks, notes and messages", pictures: ["search"] }],
	},
	{
		id: "subagents",
		title: "Subagents",
		items: [
			{
				text: "Open as full thread views with live progress; access levels, approvals, interject and Stop",
				pictures: ["sub", "subacc"],
			},
		],
	},
	{
		id: "ask",
		title: "Ask mode",
		items: [
			{ text: "/ask and /act anywhere in a message", pictures: ["askcmd"] },
			{ text: "Ask mode can't write files, even through the terminal", pictures: ["askguard"] },
		],
	},
	{
		id: "configurations",
		title: "Configurations",
		items: [
			{ text: "Saved configurations with a provider allowlist and a default effort", pictures: ["cfg"] },
			{ text: "Model and effort in the composer are per-chat; reopened chats restore theirs", pictures: ["pill"] },
			{
				text: "Azure: newer models that need the Responses endpoint work, with the updated OpenAI Compatible form",
				pictures: ["azure"],
			},
		],
	},
	{
		id: "composer",
		title: "Composer",
		items: [
			{ text: "＋ menu: @ mentions, files, MCP servers, rules, workflows and scripts", pictures: ["plus"] },
			{ text: "Where pill: task, workspace and worktree in one place", pictures: ["where"] },
			{ text: "Context ring with cost and approvals", pictures: ["ring"] },
			{ text: "Workflows expand anywhere in a message", pictures: ["wf"] },
		],
	},
	{
		id: "navigation",
		title: "Toasts & Back",
		items: [
			{ text: "Toasts when a background thread finishes or needs input", pictures: ["toast"] },
			{ text: "Back remembers where you were; long-press for the history", pictures: ["back"] },
		],
	},
	{
		id: "profiles",
		title: "Profiles",
		items: [
			{ text: "One page for profiles and Ask/Act defaults, with an optional separate Ask profile", pictures: ["aa"] },
			{ text: "Pick a profile for subagents, walkthrough Generate and thread titles", pictures: ["usedby"] },
		],
	},
	{
		id: "terminal",
		title: "Terminal environment",
		items: [
			{
				text: "Global and workspace variables, a .env file and PATH entries for every command Cline runs",
				pictures: ["env"],
			},
		],
	},
	{
		id: "worktrees",
		title: "Worktrees",
		items: [
			{ text: "Run a thread in its own git or mm worktree; toggle it in the where pill", pictures: ["wt"] },
			{ text: "Bring here, Undo, Take over and Remove from the breadcrumb ⋯ menu", pictures: ["wtmenu"] },
		],
	},
	{
		id: "walkthrough",
		title: "Change walkthrough",
		items: [
			{ text: "A guided tour of a thread's changes: chapters and collapsible hunks", pictures: ["walk"] },
			{ text: "Check off stops, add notes, and send them back to the thread", pictures: ["walknote"] },
		],
	},
	{
		// Scripts are built in parallel with this page; keep this line in sync with what ships.
		id: "scripts",
		title: "Scripts",
		items: [{ text: "Saved commands with typed options, run by you or the agent", pictures: ["script"] }],
	},
	{
		id: "mcp",
		title: "MCP & hooks",
		items: [{ text: "McpServerStart hooks; open chats pick up MCP changes", pictures: ["mcp"] }],
	},
]

export interface FixGroup {
	id: string
	title: string
	items: string[]
}

export const IMPROVEMENT_GROUPS: FixGroup[] = [
	{
		id: "chat",
		title: "Chat & composer",
		items: [
			"The first message is always a chat bubble; editing a message keeps the thread",
			"Large rows no longer make the chat jump while scrolling",
			"Minimap and scroll-to-bottom follow turns; minimap squares use the chat's own block colors and stay steady while a reply streams",
			"You can quote text inside completed and answer blocks",
			"Inline images are capped at 280px tall",
			"Interjected prompts never reappear in the queue",
			"Chat times show last activity, not settle time",
		],
	},
	{
		id: "providers",
		title: "Settings & providers",
		items: [
			"Each model's configured context window is respected",
			'OpenAI Compatible: full settings in the configuration editor, a "none" effort, and clearer HTTP errors',
			"Azure and other endpoints that need the Responses API are routed there, on any host",
			"Reasoning items are carried between turns on OpenAI-compatible endpoints",
			"The model picker shows the focused chat's live model and keeps queued switches",
		],
	},
	{
		id: "agents",
		title: "Subagents, Ask mode & hooks",
		items: [
			"Subagents show live progress, actionable decisions and open while running",
			"Stopping a subagent lets its parent continue",
			"Subagent token totals stay right across reload and cancel",
			"Ask mode can't write files through the terminal, including via xargs, find or parallel",
			"Ask-mode MCP tools follow your MCP auto-approve setting",
			"Hooks no longer run (and show) on every turn",
		],
	},
	{
		id: "performance",
		title: "Performance",
		items: ["Large patches and edits no longer block the extension", "Large edit previews and diffs no longer freeze the UI"],
	},
	{
		id: "platform",
		title: "Platform (Windows, Linux & macOS)",
		items: [
			"⌘ shortcuts use Ctrl on Windows and Linux, and labels show the right key",
			"⌘K / Ctrl+K is claimed while Cline is focused, so VS Code's K chord (⌘K Z, ⌘K W) can't swallow the next key",
			"Installs next to the Marketplace Cline, with its own extension, views and commands",
		],
	},
]

export interface ShortcutRow {
	id: string
	label: string
	keys: string
}

export interface ShortcutOptions {
	/** "⌘" on macOS, "Ctrl" elsewhere. */
	mod: string
	/** "⌥" on macOS, "Alt" elsewhere. */
	alt: string
	/** Platform config value such as "Meta+Shift+a". */
	toggleKeys: string
	/** What plain Enter does while the agent is running. */
	enterSendsAs: "steer" | "interject"
}

/** "Meta+Shift+a" -> "⌘+Shift+A", the same format the composer shows. */
export function formatToggleKeys(toggleKeys: string, mod: string): string {
	return toggleKeys.replace("Meta", mod).replace(/.$/, (c) => c.toUpperCase())
}

// Every row here maps to a real binding: package.json keybindings (search, add to chat / focus input),
// the platform config (Ask/Act) and composerKeys.ts (the Enter family).
export function buildShortcuts({ mod, alt, toggleKeys, enterSendsAs }: ShortcutOptions): ShortcutRow[] {
	const other = enterSendsAs === "steer" ? "Interject" : "Steer"
	const plain = enterSendsAs === "steer" ? "Steer" : "Interject"
	return [
		{ id: "search", label: "Search (while Cline is focused)", keys: `${mod}+K` },
		{ id: "mode", label: "Toggle Ask / Act", keys: formatToggleKeys(toggleKeys, mod) },
		{ id: "chat", label: "Add selection to chat, or focus the input", keys: `${mod}+'` },
		{ id: "send", label: "Send", keys: "Enter" },
		{ id: "newline", label: "New line", keys: "Shift+Enter" },
		{ id: "aside", label: "Send as an aside", keys: `${alt}+Enter` },
		{ id: "background", label: "Start in the background (home)", keys: `${mod}+Enter` },
		{ id: "running", label: `While running: ${plain}`, keys: "Enter" },
		{ id: "running-other", label: `While running: ${other}`, keys: `${mod}+Enter` },
	]
}
