import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { PictureKey } from "./aboutContent"

// Tiny static drawings of the real UI (about 100x48), styled with the VS Code theme variables
// so they follow the user's theme. They are pictures only: nothing here is interactive.

const BLUE = "text-(--vscode-charts-blue)"
const PURPLE = "text-(--vscode-charts-purple)"

const Row = ({ children, className }: { children?: ReactNode; className?: string }) => (
	<div
		className={cn(
			"mb-[2px] flex items-center gap-[3px] overflow-hidden whitespace-nowrap rounded-[3px] bg-input-background px-[3px] py-px",
			className,
		)}>
		{children}
	</div>
)

const Chip = ({ children, active, className }: { children?: ReactNode; active?: boolean; className?: string }) => (
	<span
		className={cn(
			"mr-[2px] mb-[2px] inline-block whitespace-nowrap rounded-[3px] px-1",
			active ? "bg-selection text-selection-foreground" : "bg-input-background",
			className,
		)}>
		{children}
	</span>
)

const Dim = ({ children }: { children?: ReactNode }) => <span className="ml-auto text-description">{children}</span>

const PICTURES: Record<PictureKey, { label: string; node: ReactNode }> = {
	inbox: {
		label: "Home inbox",
		node: (
			<>
				<Row>▣ Bulk invoice export</Row>
				<Row>
					<span className={BLUE}>◌</span>Implement steps
				</Row>
				<Row>
					<span className="text-success">✓</span>Why is CI flaky
				</Row>
			</>
		),
	},
	bg: {
		label: "Background chat",
		node: (
			<>
				<Row>
					<span className={BLUE}>◌</span>Fix export bug <span className={cn("ml-auto", BLUE)}>running</span>
				</Row>
				<Row className="opacity-60">✕ closed tab</Row>
			</>
		),
	},
	interject: {
		label: "Interject into a running turn",
		node: (
			<>
				<Row>also check retries…</Row>
				<Row className="bg-transparent">
					<Chip active>Interject</Chip>
					<Chip>Queue</Chip>
				</Row>
			</>
		),
	},
	strip: {
		label: "Threads strip and minimap",
		node: (
			<>
				<div className="mb-[3px] flex gap-[2px]">
					<Chip>Plan</Chip>
					<Chip>Impl</Chip>
					<Chip>Tests</Chip>
				</div>
				<div className="flex items-end gap-[2px]">
					<i className="h-4 w-[5px] rounded-[1px] bg-(--vscode-charts-blue)" />
					<i className="h-[10px] w-[5px] rounded-[1px] bg-description opacity-60" />
					<i className="h-5 w-[5px] rounded-[1px] bg-description opacity-60" />
					<i className="h-2 w-[5px] rounded-[1px] bg-description opacity-60" />
				</div>
			</>
		),
	},
	quote: {
		label: "Quoted message text",
		node: (
			<>
				<Row className="border-l-2 border-l-(--vscode-charts-blue)">“cap at 10k rows”</Row>
				<Row>› quoted in composer</Row>
			</>
		),
	},
	task: {
		label: "Task page",
		node: (
			<>
				<Row>
					<b>Bulk invoice export</b>
				</Row>
				<Row>◌ Implement steps</Row>
				<Row className={PURPLE}>▤ Dev plan</Row>
			</>
		),
	},
	note: {
		label: "Note mention",
		node: (
			<>
				<Row className={PURPLE}>▤ Decisions</Row>
				<Row>
					see <span className={PURPLE}>#Decisions</span>
				</Row>
			</>
		),
	},
	review: {
		label: "Unified note review",
		node: (
			<>
				<Row className="text-success">+ 10k row cap</Row>
				<Row className="text-error">− no limit</Row>
				<Row className="bg-transparent">
					<Chip>Accept all</Chip>
					<Chip>Discard</Chip>
				</Row>
			</>
		),
	},
	hist: {
		label: "Note history",
		node: (
			<>
				<Row>
					v3 <Dim>now</Dim>
				</Row>
				<Row>
					v2 <Dim>2h ago</Dim>
				</Row>
				<Row className="bg-transparent">
					<Chip>Compare</Chip>
					<Chip>Restore</Chip>
				</Row>
			</>
		),
	},
	convert: {
		label: "Convert a note",
		node: (
			<>
				<Row className={PURPLE}>▤ Release steps</Row>
				<Row className="bg-transparent">
					<Chip>Rule</Chip>
					<Chip active>Skill</Chip>
					<Chip>Workflow</Chip>
				</Row>
			</>
		),
	},
	wrap: {
		label: "Wrap-up review",
		node: (
			<>
				<Row>Task settled</Row>
				<Row className="bg-transparent">
					<Chip>Review notes</Chip>
					<Chip>Skip</Chip>
				</Row>
			</>
		),
	},
	xnote: {
		label: "Note from another task",
		node: (
			<>
				<Row>
					<span className={PURPLE}>#</span>Decisions
				</Row>
				<Row>
					<span className={PURPLE}>#</span>API/Limits <Dim>Billing</Dim>
				</Row>
			</>
		),
	},
	thread: {
		label: "Thread mention",
		node: (
			<>
				<Row>
					<span className="text-link">thread:</span>flaky
				</Row>
				<Row>
					Why is CI flaky <Dim>Infra</Dim>
				</Row>
			</>
		),
	},
	link: {
		label: "Message link",
		node: (
			<>
				<Row>Copy link</Row>
				<Row className="border-l-2 border-l-(--vscode-charts-blue)">“retry twice”</Row>
			</>
		),
	},
	tags: {
		label: "Tags",
		node: (
			<div>
				<Chip className="text-link">PROJ-482</Chip>
				<Chip className="text-success">⎇ bulk-export</Chip>
				<Chip>label</Chip>
			</div>
		),
	},
	branch: {
		label: "Branch tag",
		node: (
			<>
				<Row>branch:bulk-export</Row>
				<div>
					<Chip className="text-success">⎇ bulk-export</Chip>
				</div>
			</>
		),
	},
	ghost: {
		label: "Task suggestion for the branch",
		node: (
			<>
				<Row>
					<span className="text-description">Bulk invoice export</span>
				</Row>
				<div>
					<Chip className="text-success">⎇ bulk-export</Chip>
					<Chip className="border border-dashed border-description text-description">Bulk export?</Chip>
				</div>
			</>
		),
	},
	search: {
		label: "Search",
		node: (
			<>
				<Row className="border border-(--vscode-focusBorder)">
					⌕ export <Dim>⌘K</Dim>
				</Row>
				<Row>Bulk invoice export</Row>
			</>
		),
	},
	sub: {
		label: "Subagent thread",
		node: (
			<>
				<Row>
					◇ <b>Subagent</b> Map paths
				</Row>
				<Row>
					<span className={BLUE}>◌</span>reading 12 files
				</Row>
			</>
		),
	},
	subacc: {
		label: "Subagent access and Stop",
		node: (
			<>
				<Row>
					Access <Dim>Read only ▾</Dim>
				</Row>
				<Row className="bg-transparent">
					<Chip>Stop</Chip>
					<Chip>Interject</Chip>
				</Row>
			</>
		),
	},
	askcmd: {
		label: "Ask and Act commands",
		node: (
			<>
				<Row>
					<span className="text-link">/ask</span> why is it slow
				</Row>
				<div>
					<Chip active>Ask</Chip>
					<Chip>Act</Chip>
				</div>
			</>
		),
	},
	askguard: {
		label: "Ask mode blocks writes",
		node: (
			<>
				<Row className="text-error">✕ write blocked</Row>
				<Row>$ sed -i … (Ask mode)</Row>
			</>
		),
	},
	cfg: {
		label: "Saved configurations",
		node: (
			<>
				<Row>Deep · opus-5.5</Row>
				<Row>Fast · haiku-5.5</Row>
			</>
		),
	},
	pill: {
		label: "Model and effort pill",
		node: (
			<>
				<Row className="h-3" />
				<div>
					<Chip>Deep · high ▾</Chip>
				</div>
			</>
		),
	},
	azure: {
		label: "Azure Responses endpoint",
		node: (
			<>
				<Row>Azure OpenAI</Row>
				<Row>
					API: <Dim>Responses ▾</Dim>
				</Row>
			</>
		),
	},
	plus: {
		label: "Plus menu",
		node: (
			<>
				<Row>@ Mention</Row>
				<Row>▤ Files & images</Row>
				<Row>⚡ MCP · Rules</Row>
			</>
		),
	},
	where: {
		label: "Where pill",
		node: (
			<>
				<Row>Task: Bulk export</Row>
				<Row>
					Workspace <Dim>⑂ worktree</Dim>
				</Row>
			</>
		),
	},
	ring: {
		label: "Context ring",
		node: (
			<>
				<Row className="h-3" />
				<div>
					<Chip>＋</Chip>
					<Chip>◔ 42%</Chip>
					<Chip>Act</Chip>
				</div>
			</>
		),
	},
	wf: {
		label: "Workflow in a message",
		node: (
			<Row>
				fix it, then <span className={PURPLE}>/release.md</span>
			</Row>
		),
	},
	toast: {
		label: "Thread toast",
		node: (
			<>
				<Row>
					<span className="text-success">✓</span>Fix export bug <Dim>×</Dim>
				</Row>
				<Row className="bg-transparent">
					<Chip>Open</Chip>
				</Row>
			</>
		),
	},
	back: {
		label: "Back button",
		node: (
			<>
				<Row>
					← Notebook <Dim>|</Dim>
				</Row>
				<Row className="opacity-70">Home › Task › Thread</Row>
			</>
		),
	},
	aa: {
		label: "Ask and Act defaults",
		node: (
			<>
				<Row>
					Different profile for Ask and Act <span className="ml-auto">◐</span>
				</Row>
				<Row>
					Default <Dim>Deep ▾</Dim>
				</Row>
			</>
		),
	},
	usedby: {
		label: "Used by",
		node: (
			<>
				<Row>
					Subagents <Dim>Fast ▾</Dim>
				</Row>
				<Row>
					Walkthrough <Dim>Deep ▾</Dim>
				</Row>
				<Row>
					Thread titles <Dim>Fast ▾</Dim>
				</Row>
			</>
		),
	},
	env: {
		label: "Terminal environment",
		node: (
			<>
				<Row>
					JAVA_HOME <Dim>••••••</Dim>
				</Row>
				<Row>
					PATH <Dim>+ 2</Dim>
				</Row>
			</>
		),
	},
	wt: {
		label: "Worktree toggle",
		node: (
			<>
				<Row>
					Workspace <Dim>Worktree ▾</Dim>
				</Row>
				<Row>
					Bulk export <span className="ml-auto text-success">⑂</span>
				</Row>
			</>
		),
	},
	wtmenu: {
		label: "Worktree actions",
		node: (
			<>
				<Row>Bring here</Row>
				<Row>Undo · Take over</Row>
				<Row className="text-error">Remove</Row>
			</>
		),
	},
	walk: {
		label: "Change walkthrough",
		node: (
			<>
				<Row>
					<b>1</b> Export endpoint
				</Row>
				<Row className="text-success">+ row cap</Row>
				<Row className="opacity-60">▸ 2 hunks</Row>
			</>
		),
	},
	walknote: {
		label: "Walkthrough review notes",
		node: (
			<>
				<Row>
					<span className="text-success">✓</span>Export endpoint <Dim>2/4</Dim>
				</Row>
				<Row className="bg-transparent">
					<Chip>Add note</Chip>
					<Chip active>Send</Chip>
				</Row>
			</>
		),
	},
	script: {
		label: "Script options",
		node: (
			<>
				<Row>
					<span className="text-link">/deploy</span> env:staging
				</Row>
				<Row className="bg-transparent">
					<Chip>--dry-run</Chip>
					<Chip>env ▾</Chip>
				</Row>
			</>
		),
	},
	mcp: {
		label: "MCP and hooks",
		node: (
			<>
				<Row>
					⚡ github <span className="ml-auto text-success">on</span>
				</Row>
				<Row>↪ McpServerStart</Row>
			</>
		),
	},
}

/** A picture, role="img" so tests and screen readers can find it by label. */
export const AboutPicture = ({ name }: { name: PictureKey }) => {
	const picture = PICTURES[name]
	return (
		<div
			aria-label={picture.label}
			className="h-12 w-[100px] shrink-0 overflow-hidden rounded-[5px] border border-editor-group-border bg-code-background p-1 text-[8.5px] leading-[1.3] text-foreground"
			data-testid={`about-picture-${name}`}
			role="img">
			{picture.node}
		</div>
	)
}

export const PICTURE_KEYS = Object.keys(PICTURES) as PictureKey[]
