import React, { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { HeaderIconButton } from "./HeaderIconButton"

export interface Crumb {
	id: string
	label: string
	kind: "home" | "task" | "thread"
	/** Aside or subagent, shown with a `↳` prefix. */
	sub?: boolean
	/** Absent on the current (last) crumb. */
	onSelect?: () => void
}

interface BreadcrumbProps {
	/** Home first, the focused thread last. */
	crumbs: Crumb[]
	/** Saves a new title for the last crumb; renaming is off without it. */
	onRename?: (title: string) => void
}

// Rough widths (px) used to decide when the middle levels collapse to `…`.
const HOME_WIDTH = 20
const SEPARATOR_WIDTH = 14
const MIN_MIDDLE_WIDTH = 56
const MIN_CURRENT_WIDTH = 96

/** True when every middle level can't keep a readable minimum width beside home and the current thread. */
export function shouldCollapseCrumbs(available: number, middleCount: number): boolean {
	if (middleCount === 0 || available <= 0) return false
	return available < HOME_WIDTH + MIN_CURRENT_WIDTH + (middleCount + 1) * SEPARATOR_WIDTH + middleCount * MIN_MIDDLE_WIDTH
}

const CRUMB_BUTTON_CLASS =
	"flex min-w-0 items-center gap-1 rounded-xs border-0 bg-transparent px-0.5 py-0 text-[12px] text-description cursor-pointer hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

const MENU_ITEM_CLASS =
	"flex h-6 w-full items-center gap-1.5 rounded-xs border-0 bg-transparent pr-2 text-left text-[12px] text-menu-foreground cursor-pointer hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-default disabled:hover:bg-transparent"

const Separator = () => (
	<span aria-hidden className="shrink-0 text-[12px] text-description/60">
		/
	</span>
)

const CrumbLabel = ({ crumb }: { crumb: Crumb }) => (
	<>
		{crumb.kind === "home" ? (
			<span aria-hidden className="codicon codicon-home text-[13px]" />
		) : (
			crumb.kind === "task" && <span aria-hidden className="codicon codicon-tasklist shrink-0 text-[12px]" />
		)}
		{crumb.kind !== "home" && (
			<span className="ph-no-capture min-w-0 truncate">
				{crumb.sub && "↳ "}
				{crumb.label}
			</span>
		)}
	</>
)

/**
 * `‹ ⌂ / Task / Thread / ↳ subthread`. When the levels don't fit, everything
 * between home and the current thread collapses into `…`, which opens a menu of
 * every level in order. ✎ or a double-click renames the current thread inline.
 */
export const Breadcrumb: React.FC<BreadcrumbProps> = ({ crumbs, onRename }) => {
	const listRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const settledRef = useRef(false)
	const [width, setWidth] = useState(0)
	const [menuOpen, setMenuOpen] = useState(false)
	const [renaming, setRenaming] = useState(false)
	const [draft, setDraft] = useState("")

	const home = crumbs[0]
	const current = crumbs[crumbs.length - 1]
	const middle = crumbs.slice(1, -1)
	const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined
	const collapsed = shouldCollapseCrumbs(width, middle.length)

	useLayoutEffect(() => {
		const element = listRef.current
		if (!element) return
		setWidth(element.clientWidth)
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry) setWidth(entry.contentRect.width)
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	useEffect(() => {
		if (!renaming) return
		inputRef.current?.focus()
		inputRef.current?.select()
	}, [renaming])

	// biome-ignore lint/correctness/useExhaustiveDependencies: leaving the thread drops an unsaved rename
	useEffect(() => setRenaming(false), [current.id])

	const startRename = () => {
		if (!onRename) return
		settledRef.current = false
		setDraft(current.label)
		setRenaming(true)
	}
	const finishRename = (save: boolean) => {
		if (settledRef.current) return
		settledRef.current = true
		setRenaming(false)
		const title = draft.trim().replace(/\s+/g, " ")
		if (save && title !== current.label) onRename?.(title)
	}

	const renderCrumb = (crumb: Crumb) => (
		<button
			className={cn(CRUMB_BUTTON_CLASS, crumb.kind === "home" ? "shrink-0" : "shrink")}
			data-testid={`crumb-${crumb.kind}`}
			key={crumb.id}
			onClick={crumb.onSelect}
			title={crumb.kind === "home" ? "Home" : crumb.label}
			type="button">
			{crumb.kind === "home" ? <span className="sr-only">Home</span> : null}
			<CrumbLabel crumb={crumb} />
		</button>
	)

	return (
		<nav aria-label="Thread path" className="flex min-w-0 flex-1 items-center gap-1" data-testid="task-breadcrumb">
			<HeaderIconButton
				data-testid="crumb-back"
				disabled={!parent?.onSelect}
				icon="chevron-left"
				label="Back"
				onClick={parent?.onSelect}
				tooltip={parent ? `Back to ${parent.kind === "home" ? "home" : parent.label}` : "Back"}
			/>
			<div className="flex min-w-0 flex-1 items-center gap-1" ref={listRef}>
				{crumbs.length > 1 && (
					<>
						{renderCrumb(home)}
						<Separator />
						{collapsed ? (
							<>
								<Popover onOpenChange={setMenuOpen} open={menuOpen}>
									<PopoverTrigger asChild>
										<button
											aria-label="Show all levels"
											className={cn(CRUMB_BUTTON_CLASS, "shrink-0", menuOpen && "text-foreground")}
											data-testid="crumb-more"
											type="button">
											…
										</button>
									</PopoverTrigger>
									<PopoverContent align="start" className="w-64 p-1 motion-reduce:animate-none" side="bottom">
										<div className="flex flex-col" data-testid="crumb-menu" role="menu">
											{crumbs.map((crumb, depth) => {
												const isCurrent = crumb === current
												return (
													<button
														aria-current={isCurrent ? "page" : undefined}
														className={MENU_ITEM_CLASS}
														disabled={isCurrent}
														key={crumb.id}
														onClick={() => {
															setMenuOpen(false)
															crumb.onSelect?.()
														}}
														role="menuitem"
														style={{ paddingLeft: 8 + depth * 8 }}
														type="button">
														<CrumbLabel crumb={crumb} />
														{crumb.kind === "home" && "Home"}
														{isCurrent && (
															<span
																aria-hidden
																className="codicon codicon-check ml-auto text-[12px]"
															/>
														)}
													</button>
												)
											})}
										</div>
									</PopoverContent>
								</Popover>
								<Separator />
							</>
						) : (
							middle.map((crumb) => (
								<React.Fragment key={crumb.id}>
									{renderCrumb(crumb)}
									<Separator />
								</React.Fragment>
							))
						)}
					</>
				)}
				{renaming ? (
					<div className="flex min-w-[130px] flex-1 items-center gap-0.5">
						<input
							aria-label="Thread title"
							className="ph-no-capture h-5.5 min-w-0 flex-1 rounded-xs border border-(--vscode-focusBorder) bg-input-background px-1.5 text-[12px] text-input-foreground outline-none"
							data-testid="crumb-rename-input"
							onBlur={() => finishRename(true)}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault()
									finishRename(true)
								} else if (event.key === "Escape") {
									event.preventDefault()
									event.stopPropagation()
									finishRename(false)
								}
							}}
							placeholder="Thread title"
							ref={inputRef}
							value={draft}
						/>
						<HeaderIconButton
							data-testid="crumb-rename-save"
							icon="check"
							label="Save title"
							onClick={() => finishRename(true)}
							// Keep focus in the input so its blur doesn't save first.
							onMouseDown={(event) => event.preventDefault()}
						/>
					</div>
				) : (
					// biome-ignore lint/a11y/noStaticElementInteractions: double-click is a mouse shortcut; ✎ is the keyboard path
					// biome-ignore lint/a11y/noNoninteractiveElementInteractions: same as above
					<span
						className={cn(
							"flex min-w-0 items-center gap-1 text-[13px] font-semibold text-foreground",
							// Beside visible middle levels the current thread keeps up to 60% and they truncate first.
							middle.length > 0 && !collapsed ? "max-w-[60%] shrink-0" : "shrink",
						)}
						data-testid="task-header-title"
						onDoubleClick={startRename}>
						<span
							className="ph-no-capture min-w-0 truncate"
							data-testid="task-header-title-text"
							title={current.label}>
							{current.sub && "↳ "}
							{current.label}
						</span>
						{onRename && (
							<button
								aria-label="Rename thread"
								className="flex shrink-0 items-center rounded-xs border-0 bg-transparent p-0 text-description cursor-pointer hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
								data-testid="crumb-rename"
								onClick={startRename}
								title="Rename thread (or double-click the title)"
								type="button">
								<span aria-hidden className="codicon codicon-edit text-[12px]" />
							</button>
						)}
					</span>
				)}
			</div>
		</nav>
	)
}
