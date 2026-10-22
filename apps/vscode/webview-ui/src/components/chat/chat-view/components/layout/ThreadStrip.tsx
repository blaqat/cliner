import {
	ChevronDownIcon,
	ChevronRightIcon,
	CornerDownRightIcon,
	MessageSquareIcon,
	MessagesSquareIcon,
	XIcon,
} from "lucide-react"
import { memo, useMemo, useState } from "react"
import { SessionStatusIcon } from "@/components/inbox/SessionStatusIcon"
import { openTask } from "@/components/inbox/sessionActions"
import type { ThreadStatus } from "@/components/inbox/threadStatus"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { buildThreadItems, type ThreadItem } from "../../utils/threadUtils"

/** A top-level aside and every aside under it, shown as one bracketed group when it has any. */
interface ThreadGroup {
	lead: ThreadItem
	members: ThreadItem[]
}

/** Splits the tree-ordered asides into groups: each depth-1 aside leads the deeper ones after it. */
function groupAsides(asides: readonly ThreadItem[]): ThreadGroup[] {
	const groups: ThreadGroup[] = []
	for (const item of asides) {
		if ((item.depth ?? 1) <= 1 || groups.length === 0) groups.push({ lead: item, members: [] })
		else groups[groups.length - 1].members.push(item)
	}
	return groups
}

/** What a folded group still shows from inside it: something waiting beats running beats subagents. */
const ACTIVITY_ORDER: ThreadStatus[] = ["waiting", "running", "subagents"]
function foldedActivity(members: readonly ThreadItem[]): ThreadItem | undefined {
	for (const status of ACTIVITY_ORDER) {
		const found = members.find((member) => member.status === status)
		if (found) return found
	}
	return undefined
}

// Folded groups survive the strip unmounting (switching views) for the rest of the session.
const foldedLeads = new Set<string>()

interface ThreadChipProps {
	item: ThreadItem
	onOpen: (item: ThreadItem) => void
	onClose: (item: ThreadItem) => void
	/** Inside a group's bracket: a little shorter, so the frame stays the height of a chip. */
	inGroup?: boolean
	/** The group's first chip: a fold chevron, the two-bubble icon, and (folded) a count. */
	lead?: { expanded: boolean; onToggle: () => void; hiddenCount: number; activity?: ThreadItem }
}

const ThreadChip = ({ item, onOpen, onClose, inGroup = false, lead }: ThreadChipProps) => {
	const clickable = !item.current
	const tooltip = item.kind === "main" ? "Main conversation" : `Aside: ${item.title}`
	const nested = (item.depth ?? 1) >= 2
	const KindIcon = lead ? MessagesSquareIcon : nested ? CornerDownRightIcon : MessageSquareIcon
	const folded = lead && !lead.expanded
	const statusItem = folded && lead.activity ? lead.activity : item

	return (
		<div
			aria-current={item.current || undefined}
			aria-label={clickable ? tooltip : undefined}
			className={cn(
				// Room for the title plus the kind and status icons before the strip starts scrolling.
				"group/chip flex min-w-[calc(12px+12px+10ch)] max-w-48 flex-[0_1_auto] items-center gap-1 rounded-xs border py-0.5 pr-1 text-[11px] animate-row-in motion-reduce:animate-none",
				inGroup ? "h-4.5" : "h-5.5",
				lead ? "pl-0.5" : "pl-1.5",
				item.current
					? "border-(--vscode-focusBorder) bg-selection/40 text-foreground"
					: lead
						? "border-transparent bg-transparent text-description"
						: "border-editor-group-border bg-input-background/50 text-description",
				clickable && "cursor-pointer hover:text-foreground hover:bg-list-hover",
			)}
			data-kind={item.kind}
			data-testid="thread-chip"
			onClick={clickable ? () => onOpen(item) : undefined}
			onKeyDown={
				clickable
					? (event) => {
							if (event.target !== event.currentTarget) return
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault()
								onOpen(item)
							}
						}
					: undefined
			}
			role={clickable ? "button" : undefined}
			tabIndex={clickable ? 0 : undefined}
			title={tooltip}>
			{lead && (
				<button
					aria-expanded={lead.expanded}
					aria-label={`${lead.expanded ? "Fold" : "Unfold"} ${item.title}'s asides`}
					className="flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-0 bg-transparent p-0 text-description hover:bg-list-hover hover:text-foreground"
					data-testid="thread-group-toggle"
					onClick={(event) => {
						event.stopPropagation()
						lead.onToggle()
					}}
					title={lead.expanded ? "Fold" : "Unfold"}
					type="button">
					{lead.expanded ? <ChevronDownIcon className="size-2.5" /> : <ChevronRightIcon className="size-2.5" />}
				</button>
			)}
			<KindIcon className="size-3 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{item.title}</span>
			{folded && lead.hiddenCount > 0 && (
				<span className="shrink-0 text-[10px] opacity-70" data-testid="thread-group-count">
					+{lead.hiddenCount}
				</span>
			)}
			<SessionStatusIcon
				className={statusItem.status === "running" || statusItem.status === "subagents" ? "size-2.5" : undefined}
				label={
					statusItem === item ? item.statusLabel : `${statusItem.title}: ${statusItem.statusLabel ?? statusItem.status}`
				}
				status={statusItem.status}
			/>
			{item.kind !== "main" && (
				<button
					aria-label={lead ? `Close aside ${item.title} and its asides` : `Close aside ${item.title}`}
					className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border-0 bg-transparent p-0 text-description opacity-60 hover:text-foreground hover:opacity-100 cursor-pointer"
					onClick={(event) => {
						event.stopPropagation()
						onClose(item)
					}}
					title="Close"
					type="button">
					<XIcon className="size-2.5" />
				</button>
			)}
		</div>
	)
}

/**
 * Human-made threads of the focused chat, directly under the task header:
 * Main and its asides. Hidden when the chat has no asides; subagents are in
 * the header's subagent panel. Closing an aside only hides the chip (the
 * session keeps running).
 *
 * An aside with asides of its own is a group, like a browser tab group in our
 * chip style: a chip-border bracket around it and everything under it, led by
 * a fold chevron. Folded, the bracket keeps the lead, a +N count and the most
 * urgent status inside. The group holding the thread on screen never stays
 * folded.
 */
const ThreadStrip = () => {
	const { currentTaskItem, taskHistory, sessionStatuses } = useExtensionState()
	const [open, setOpen] = useState(true)
	const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set())
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(foldedLeads))

	const items = useMemo(
		() => buildThreadItems(currentTaskItem, taskHistory ?? [], sessionStatuses, hiddenIds),
		[currentTaskItem, taskHistory, sessionStatuses, hiddenIds],
	)
	const groups = useMemo(() => groupAsides(items.slice(1)), [items])

	if (items.length === 0) {
		return null
	}

	const main = items[0]
	const handleClose = (item: ThreadItem) => {
		// Closing a group's lead hides the whole group (buildThreadItems drops the subtree).
		const group = groups.find((g) => g.lead.id === item.id)
		setHiddenIds((current) => new Set(current).add(item.id))
		if (item.current || group?.members.some((member) => member.current)) {
			void openTask(main.id)
		}
	}
	const toggle = (leadId: string) => {
		if (foldedLeads.has(leadId)) foldedLeads.delete(leadId)
		else foldedLeads.add(leadId)
		setFolded(new Set(foldedLeads))
	}
	const openItem = (item: ThreadItem) => void openTask(item.id)

	return (
		<div className="mx-4 mb-1 flex flex-col gap-1 border-b border-editor-group-border pb-1.5" data-testid="thread-strip">
			<button
				aria-expanded={open}
				className="flex w-fit items-center gap-1 border-0 bg-transparent p-0 text-[10.5px] font-medium uppercase tracking-wider text-description hover:text-foreground cursor-pointer"
				onClick={() => setOpen((value) => !value)}
				type="button">
				{open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
				Threads
				<span className="opacity-70">{items.length - 1}</span>
			</button>
			{open && (
				<div className="flex items-center gap-1 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
					<ThreadChip item={main} key={`main:${main.id}`} onClose={handleClose} onOpen={openItem} />
					{groups.map(({ lead, members }) => {
						if (members.length === 0) {
							return <ThreadChip item={lead} key={`aside:${lead.id}`} onClose={handleClose} onOpen={openItem} />
						}
						// The group you're in never stays folded.
						const expanded = !folded.has(lead.id) || lead.current || members.some((member) => member.current)
						return (
							<div
								aria-label={`${lead.title} and its asides`}
								className="flex shrink-0 items-center gap-0.5 rounded-xs border border-editor-group-border bg-input-background/20 p-px"
								data-folded={expanded ? undefined : "true"}
								data-testid="thread-group"
								key={`group:${lead.id}`}
								role="group">
								<ThreadChip
									inGroup
									item={lead}
									lead={{
										expanded,
										onToggle: () => toggle(lead.id),
										hiddenCount: members.length,
										activity: foldedActivity(members),
									}}
									onClose={handleClose}
									onOpen={openItem}
								/>
								{expanded &&
									members.map((member) => (
										<ThreadChip
											inGroup
											item={member}
											key={`aside:${member.id}`}
											onClose={handleClose}
											onOpen={openItem}
										/>
									))}
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}

export default memo(ThreadStrip)
