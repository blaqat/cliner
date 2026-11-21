import { StringRequest } from "@shared/proto/cline/common"
import { UpdateSkillsetItemsRequest } from "@shared/proto/cline/skillset"
import type { InstalledSkillset, SkillsetItem } from "@shared/skillsets"
import { useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { useOpenDocFile } from "@/components/docEditor/DocFileEditor"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FileServiceClient, SkillsetServiceClient } from "@/services/grpc-client"
import { NewBadge, RunsCodeChip, SkillFileList } from "./SkillBits"

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** The sets with items still waiting for a look; the one View came from first. */
export function setsWithNewItems(sets: InstalledSkillset[], highlightSetId?: string): InstalledSkillset[] {
	return sets
		.map((set) => ({ ...set, items: set.items.filter((item) => item.isNew) }))
		.filter((set) => set.items.length)
		.sort((a, b) => (a.id === highlightSetId ? -1 : b.id === highlightSetId ? 1 : b.addedAt - a.addedAt))
}

/**
 * New from a skillset, at the top of the Skills (and Workflows) tab: what each
 * item is, its files with scripts flagged, and Turn on per item or for all.
 * Items arrive off; once turned on they move to their usual list. Remove all
 * takes back everything the set added.
 */
export function NewSkillsStrip({
	sets,
	highlightSetId,
	onChanged,
}: {
	sets: InstalledSkillset[]
	highlightSetId?: string
	onChanged: () => void
}) {
	const waiting = setsWithNewItems(sets, highlightSetId)
	if (!waiting.length) return null
	return (
		<div className="mb-4 flex flex-col gap-2" data-testid="new-skills-strip">
			{waiting.map((set) => (
				<NewSetCard
					allItems={sets.find((entry) => entry.id === set.id)?.items ?? set.items}
					highlighted={set.id === highlightSetId}
					key={set.id}
					onChanged={onChanged}
					set={set}
				/>
			))}
		</div>
	)
}

function NewSetCard({
	set,
	allItems,
	highlighted,
	onChanged,
}: {
	set: InstalledSkillset
	allItems: SkillsetItem[]
	highlighted: boolean
	onChanged: () => void
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const [confirmRemove, setConfirmRemove] = useState(false)
	const [open, setOpen] = useState<string | undefined>(set.items.length === 1 ? set.items[0].path : undefined)
	const runsCode = set.items.filter((item) => item.runsCode).length
	const workflows = set.items.filter((item) => item.kind === "workflow")

	const update = async (action: "turn_on" | "remove" | "seen", paths: string[] = []) => {
		setBusy(true)
		setError(undefined)
		try {
			await SkillsetServiceClient.updateSkillsetItems(UpdateSkillsetItemsRequest.create({ setId: set.id, action, paths }))
			onChanged()
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
		}
	}

	return (
		<section
			aria-label={`New from ${set.name}`}
			className={cn(
				"rounded-xs border border-solid bg-code px-2.5 py-2 text-xs",
				highlighted ? "border-(--vscode-focusBorder)" : "border-editor-group-border",
			)}
			data-testid="new-skills-set">
			<div className="flex flex-wrap items-center gap-1.5">
				<span aria-hidden className="codicon codicon-sparkle text-(--vscode-charts-yellow)" />
				<span className="min-w-0 flex-1 truncate">
					<span className="font-semibold">{plural(set.items.length, "new item")}</span>
					<span className="text-description"> from {set.name}</span>
				</span>
				<Button disabled={busy} onClick={() => void update("turn_on")} size="xs">
					Turn all on
				</Button>
			</div>
			<p className="m-0 mt-1 text-[11px] text-description">
				Off until you turn them on. Skills are instructions Cline follows
				{runsCode ? "; scripts run only when Cline runs them, and your command approvals still apply" : ""}.
				{set.description ? ` “${set.description}”` : ""}
			</p>
			<ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
				{set.items.map((item) => (
					<NewItemRow
						busy={busy}
						item={item}
						key={item.path}
						onRemove={() => void update("remove", [item.path])}
						onToggle={() => setOpen((current) => (current === item.path ? undefined : item.path))}
						onTurnOn={() => void update("turn_on", [item.path])}
						open={open === item.path}
					/>
				))}
			</ul>
			{workflows.length > 0 && (
				<p className="m-0 mt-1.5 text-[11px] text-description">
					{workflows.length === 1 ? "The workflow starts" : "Workflows start"} when you type{" "}
					{workflows.map((item) => `/${item.name}`).join(", ")}, once on. {workflows.length === 1 ? "It's" : "They're"}{" "}
					on the Workflows tab too.
				</p>
			)}
			<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-description">
				<span>Added to all projects</span>
				<span aria-hidden>·</span>
				{confirmRemove ? (
					<span className="inline-flex flex-wrap items-center gap-1.5">
						<span className="text-foreground">
							Remove {allItems.length === 1 ? "it" : `all ${allItems.length}`}, files included?
						</span>
						<Button disabled={busy} onClick={() => void update("remove")} size="xs" variant="secondary">
							Remove
						</Button>
						<LinkButton onClick={() => setConfirmRemove(false)}>Cancel</LinkButton>
					</span>
				) : (
					<LinkButton onClick={() => setConfirmRemove(true)}>
						Remove {allItems.length === 1 ? "it" : `all ${allItems.length} from this set`}
					</LinkButton>
				)}
				<span className="flex-1" />
				<LinkButton onClick={() => void update("seen")} title="Leave them off and stop marking them new">
					Hide
				</LinkButton>
			</div>
			{error && (
				<InlineNotice className="mt-2" tone="error">
					{error}
				</InlineNotice>
			)}
		</section>
	)
}

function NewItemRow({
	item,
	open,
	busy,
	onToggle,
	onTurnOn,
	onRemove,
}: {
	item: SkillsetItem
	open: boolean
	busy: boolean
	onToggle: () => void
	onTurnOn: () => void
	onRemove: () => void
}) {
	const openDocFile = useOpenDocFile()
	const lookInside = () =>
		openDocFile
			? openDocFile({ path: item.path, kind: item.kind, isGlobal: item.isGlobal })
			: FileServiceClient.openFile(StringRequest.create({ value: item.path }))
	const folder = item.path.replace(/[\\/]SKILL\.md$/i, "")
	return (
		<li className="rounded-xs bg-(--vscode-editor-background)" data-testid="new-skill-item">
			<button
				aria-expanded={open}
				className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent px-2 py-1.5 text-left font-[inherit] text-xs text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"
				onClick={onToggle}
				type="button">
				<span
					aria-hidden
					className={cn(
						"codicon text-[11px]! text-description",
						open ? "codicon-chevron-down" : "codicon-chevron-right",
					)}
				/>
				<span className="min-w-0 truncate font-medium">{item.kind === "workflow" ? `/${item.name}` : item.name}</span>
				<NewBadge />
				{item.runsCode && <RunsCodeChip />}
				<span className="flex-1" />
				<span className="shrink-0 text-[11px] text-description">{item.kind}</span>
			</button>
			{open && (
				<div className="px-2 pb-2 pl-6">
					{item.description && <p className="m-0 mb-1.5 text-[11px] text-description">{item.description}</p>}
					{item.clashWith && (
						<p className="m-0 mb-1.5 text-[11px]">
							You already have a different <span className="font-mono">{item.clashWith}</span>, so this one came in
							as <span className="font-mono">{item.name}</span>. Both are kept.
						</p>
					)}
					<SkillFileList
						files={item.files}
						onOpen={(file) =>
							file.path === "SKILL.md" || item.kind === "workflow"
								? lookInside()
								: FileServiceClient.openFile(StringRequest.create({ value: `${folder}/${file.path}` }))
						}
					/>
					<div className="mt-2 flex flex-wrap items-center gap-1.5">
						<Button aria-label={`Turn on ${item.name}`} disabled={busy} onClick={onTurnOn} size="xs">
							Turn on
						</Button>
						<Button
							aria-label={`Look inside ${item.name}`}
							onClick={() => void lookInside()}
							size="xs"
							variant="secondary">
							Look inside
						</Button>
						<span className="flex-1" />
						<LinkButton aria-label={`Remove ${item.name}`} className="text-[11px]" disabled={busy} onClick={onRemove}>
							Remove
						</LinkButton>
					</div>
				</div>
			)}
		</li>
	)
}
