import type { ExtensionMessage } from "@shared/ExtensionMessage"
import { ModelSettingsRequestV1 } from "@shared/proto/cline/models"
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent, useMedia } from "react-use"
import { Tab, TabContent, TabList, TabTrigger } from "@/components/common/Tab"
import ViewHeader from "@/components/common/ViewHeader"
import { useNavigationHistory } from "@/components/navigation/NavigationHistoryContext"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { ModelsServiceClient } from "@/services/grpc-client"
import SettingsTargetHighlight from "../SettingsTargetHighlight"
import {
	DEFAULT_SETTINGS_PAGE,
	getNextSettingsNavigationRequestId,
	type SettingsNavigationRequest,
	type SettingsPageId,
} from "../settingsTargets"
import { AdvancedTag, RowStatus } from "./SettingRow"
import { SettingsShellContext, type SettingsShellValue, useSettingsShell } from "./SettingsShellContext"
import { SETTINGS_PAGE_VIEWS } from "./settingsPages"
import {
	changedRows,
	formatRowValue,
	isRowChanged,
	managedRows,
	resolveShellTarget,
	rowAncestors,
	rowDescription,
	type SettingsRow,
	type SettingsRowContext,
	type ShellTarget,
	searchRows,
	visiblePages,
} from "./settingsRegistry"
import { SETTINGS_ROWS } from "./settingsRows"

/** The panel width below which the nav shows icons only, with names on hover. */
const NARROW_PANEL_QUERY = "(max-width: 640px)"

type RowFilter = "changed" | "managed"

const CHIP_CLASS =
	"inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-editor-group-border bg-transparent px-2 text-[12px] text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
const CHIP_ON_CLASS = "border-selection bg-selection text-selection-foreground hover:text-selection-foreground"
const LINK_CLASS = "cursor-pointer border-0 bg-transparent p-0 text-link hover:underline"

const ResultRow = ({ row, showValue, ctx }: { row: SettingsRow; showValue: boolean; ctx: SettingsRowContext }) => {
	const shell = useSettingsShell()
	const ancestors = rowAncestors(shell.rows, row)
	const description = rowDescription(row, ctx)
	const value =
		showValue && row.kind === "preference" && isRowChanged(row, ctx)
			? `${formatRowValue(row, row.read(ctx))} · default ${formatRowValue(row, row.defaultValue(ctx))}`
			: undefined
	return (
		<div className="border-b border-editor-group-border py-1.5 last:border-b-0" data-testid={`settings-result-${row.id}`}>
			<div className="flex min-h-[18px] flex-wrap items-center gap-1.5">
				<button
					className="cursor-pointer border-0 bg-transparent p-0 text-left text-foreground hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					onClick={() => shell.openRow(row.id)}
					type="button">
					{row.label}
				</button>
				{ancestors.length > 0 && <AdvancedTag />}
				<RowStatus row={row} />
			</div>
			{ancestors.length > 0 && <div className="mt-px text-[12px] text-description">Under {ancestors[0].label}</div>}
			{description && <div className="mt-px text-[12px] text-description">{description}</div>}
			{value && <div className="mt-px text-[12px] text-description">{value}</div>}
		</div>
	)
}

const SettingsResults = ({
	rows,
	query,
	filter,
	onClear,
	onOpenPage,
}: {
	rows: readonly SettingsRow[]
	query: string
	filter: RowFilter | null
	onClear: () => void
	onOpenPage: (page: SettingsPageId) => void
}) => {
	const { ctx } = useSettingsShell()
	if (!rows.length) {
		return (
			<div className="grid justify-items-center gap-1.5 px-2.5 pt-7 pb-4 text-center text-[12.5px] text-description">
				{query ? (
					<>
						<b className="font-semibold text-foreground">No settings match “{query}”.</b>
						<span>Search already looks in every page and Advanced fold.</span>
						<button className={LINK_CLASS} onClick={onClear} type="button">
							Clear search
						</button>
					</>
				) : (
					<>
						<b className="font-semibold text-foreground">
							{filter === "managed" ? "Nothing here is managed." : "Nothing here differs from the default."}
						</b>
						<button className={LINK_CLASS} onClick={onClear} type="button">
							Show everything
						</button>
					</>
				)}
			</div>
		)
	}
	return (
		<div className="px-3 pb-3.5">
			<span className="sr-only" role="status">
				{rows.length} {rows.length === 1 ? "setting" : "settings"}
			</span>
			{visiblePages(ctx).map((page) => {
				const hits = rows.filter((row) => row.page === page.id)
				if (!hits.length) {
					return null
				}
				return (
					<Fragment key={page.id}>
						<div className="flex items-center gap-1.5 pt-3 pb-0.5 text-[11px] uppercase tracking-wider text-description">
							{page.name}
							<button
								className={cn(LINK_CLASS, "ml-auto text-[12px] normal-case tracking-normal")}
								onClick={() => onOpenPage(page.id)}
								type="button">
								Open page
							</button>
						</div>
						{hits.map((row) => (
							<ResultRow ctx={ctx} key={row.id} row={row} showValue={filter === "changed"} />
						))}
					</Fragment>
				)
			})}
		</div>
	)
}

/** `TabList` hands each child `isSelected` and `onSelect`. Narrow, the name moves to a tooltip the tab itself triggers. */
const PageTab = ({
	page,
	name,
	narrow,
	count,
	value,
	isSelected,
	onSelect,
}: {
	page: SettingsPageId
	name: string
	narrow: boolean
	/** Search hits on this page, while searching. */
	count?: number
	value: string
	isSelected?: boolean
	onSelect?: () => void
}) => {
	const Icon = SETTINGS_PAGE_VIEWS[page].icon
	const tab = (
		<TabTrigger
			aria-label={name}
			className={cn(
				"relative flex h-11 w-full cursor-pointer items-center gap-2.5 border-0 border-l-2 border-solid border-transparent bg-transparent p-0 text-foreground opacity-70 hover:bg-list-hover hover:opacity-100 focus-visible:outline! focus-visible:outline-1! focus-visible:outline-(--vscode-focusBorder)!",
				narrow ? "justify-center" : "px-3.5",
				isSelected && "border-l-foreground bg-selection text-selection-foreground opacity-100 hover:bg-selection",
				count === 0 && "opacity-45",
			)}
			data-testid={`tab-${page}`}
			isSelected={isSelected}
			onClick={onSelect}
			tabIndex={0}
			value={value}>
			<Icon aria-hidden className="size-4 shrink-0" />
			{!narrow && <span className="min-w-0 truncate text-[13px]">{name}</span>}
			{!!count && (
				<span
					className={cn(
						"rounded-lg bg-selection text-selection-foreground",
						narrow ? "absolute -top-px -right-px px-[3px] text-[9px]" : "ml-auto px-[5px] text-[11.5px]",
					)}>
					{count}
				</span>
			)}
		</TabTrigger>
	)
	if (!narrow) {
		return tab
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>{tab}</TooltipTrigger>
			<TooltipContent side="right">{name}</TooltipContent>
		</Tooltip>
	)
}

interface SettingsShellProps {
	onDone: () => void
	navigationRequest?: SettingsNavigationRequest
	/** Onboarding: this above the Models page, with no header, search or nav. */
	setupIntro?: ReactNode
}

/** The seven-page Settings. `rows` is for tests and stories that stand in their own registry. */
export const SettingsShell = ({
	navigationRequest,
	onDone,
	setupIntro,
	rows = SETTINGS_ROWS,
}: SettingsShellProps & { rows?: readonly SettingsRow[] }) => {
	const state = useExtensionState()
	const { activeOrganization } = useClineAuth()
	const ctx = useMemo<SettingsRowContext>(
		() => ({ state, activeOrganization, isDev: process.env.IS_DEV === "true" }),
		[state, activeOrganization],
	)
	const narrow = useMedia(NARROW_PANEL_QUERY, false)

	const initial = useMemo(() => resolveShellTarget(rows, navigationRequest?.target, ctx), [])
	const [pageId, setPageId] = useState<SettingsPageId>(initial?.pageId ?? DEFAULT_SETTINGS_PAGE)
	// A page stays mounted once opened, so moving around never drops an unsaved edit.
	const [visited, setVisited] = useState<ReadonlySet<SettingsPageId>>(() => new Set([initial?.pageId ?? DEFAULT_SETTINGS_PAGE]))
	const [query, setQuery] = useState("")
	const [filter, setFilter] = useState<RowFilter | null>(null)
	const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set(initial?.foldIds))
	const [pending, setPending] = useState<{ requestId: number; target: ShellTarget; source: string }>()
	const topRef = useRef<HTMLDivElement>(null)

	const showPage = useCallback((next: SettingsPageId) => {
		setPageId(next)
		setVisited((current) => (current.has(next) ? current : new Set([...current, next])))
	}, [])

	const clearListing = useCallback(() => {
		setQuery("")
		setFilter(null)
	}, [])

	const ctxRef = useRef(ctx)
	ctxRef.current = ctx
	const applyTarget = useCallback(
		(target: string, requestId: number) => {
			const resolved = resolveShellTarget(rows, target, ctxRef.current)
			if (!resolved) {
				return
			}
			clearListing()
			if (resolved.pageId) {
				showPage(resolved.pageId)
			}
			if (resolved.foldIds.length) {
				setOpenFolds((current) => new Set([...current, ...resolved.foldIds]))
			}
			setPending(resolved.elementId ? { requestId, target: resolved, source: target } : undefined)
		},
		[clearListing, rows, showPage],
	)

	const completeTarget = useCallback((requestId: number) => {
		setPending((current) => (current?.requestId === requestId ? undefined : current))
	}, [])

	useEffect(() => {
		if (navigationRequest) {
			applyTarget(navigationRequest.target, navigationRequest.requestId)
		}
	}, [applyTarget, navigationRequest])

	useEvent(
		"message",
		useCallback(
			(event: MessageEvent) => {
				const message: ExtensionMessage = event.data
				const grpcMessage = message.type === "grpc_response" ? message.grpc_response?.message : undefined
				if (grpcMessage?.key === "scrollToSettings" && grpcMessage.value) {
					applyTarget(grpcMessage.value, getNextSettingsNavigationRequestId())
				}
			},
			[applyTarget],
		),
	)

	// Another window may have changed settings since this one last looked.
	const catchUp = useCallback(() => {
		void Promise.resolve(ModelsServiceClient.getModelSettings(ModelSettingsRequestV1.create({ json: "{}" }))).catch(() => {})
	}, [])
	useEffect(catchUp, [catchUp])
	useEvent("focus", catchUp)

	// Back history records settings pages as places.
	const reportSettingsSection = useNavigationHistory()?.reportSettingsSection
	useEffect(() => reportSettingsSection?.(pageId), [reportSettingsSection, pageId])
	useEffect(() => () => reportSettingsSection?.(undefined), [reportSettingsSection])

	// Every page starts at its top; a row target then scrolls to the row.
	useEffect(() => {
		const scroller = topRef.current?.parentElement
		if (scroller) {
			scroller.scrollTop = 0
		}
	}, [pageId])

	const trimmed = query.trim()
	const changed = changedRows(rows, ctx)
	const managed = managedRows(rows, ctx)
	const hits = useMemo(() => (trimmed ? searchRows(rows, trimmed, ctx) : []), [rows, trimmed, ctx])
	const listed = useMemo(() => {
		const base: readonly SettingsRow[] = trimmed ? hits : filter === "managed" ? managed : changed
		if (!trimmed || !filter) {
			return base
		}
		const allowed = filter === "managed" ? managed : changed
		return base.filter((row) => allowed.includes(row))
	}, [trimmed, hits, filter, managed, changed])
	const listing = !!trimmed || !!filter

	const shellValue = useMemo<SettingsShellValue>(
		() => ({
			rows,
			ctx,
			isFoldOpen: (featureId) => openFolds.has(featureId),
			toggleFold: (featureId) =>
				setOpenFolds((current) => {
					const next = new Set(current)
					if (!next.delete(featureId)) {
						next.add(featureId)
					}
					return next
				}),
			openRow: (rowId) => applyTarget(rowId, getNextSettingsNavigationRequestId()),
			navigationTarget: pending && { target: pending.source, requestId: pending.requestId },
		}),
		[rows, ctx, openFolds, applyTarget, pending],
	)

	const selectPage = (next: string) => {
		clearListing()
		showPage(next as SettingsPageId)
	}

	const pages = visiblePages(ctx)

	return (
		<SettingsShellContext.Provider value={shellValue}>
			<Tab className="settings-shell">
				{setupIntro ?? <ViewHeader environment={state.environment} onDone={onDone} title="Settings" />}
				{!setupIntro && (
					<div className="flex min-w-0 items-center gap-2 border-b border-editor-group-border px-3 pb-2.5">
						<label className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-[5px] rounded-xs border border-transparent bg-input-background px-[7px] text-description focus-within:border-(--vscode-focusBorder)">
							<i aria-hidden className="codicon codicon-search shrink-0 text-[13px]!" />
							<input
								aria-label="Search settings"
								className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-input-foreground outline-none placeholder:text-description"
								onChange={(event) => setQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										setQuery("")
									} else if (event.key === "Enter" && listed.length) {
										const first = pages.flatMap((page) => listed.filter((row) => row.page === page.id))[0]
										if (first) {
											shellValue.openRow(first.id)
										}
									}
								}}
								placeholder="Search settings"
								spellCheck={false}
								value={query}
							/>
							{query && (
								<button
									aria-label="Clear"
									className="grid cursor-pointer border-0 bg-transparent p-0 text-description hover:text-foreground"
									onClick={() => setQuery("")}
									type="button">
									<i aria-hidden className="codicon codicon-close text-[13px]!" />
								</button>
							)}
						</label>
						<button
							aria-pressed={filter === "changed"}
							className={cn(CHIP_CLASS, filter === "changed" && CHIP_ON_CLASS)}
							onClick={() => setFilter((current) => (current === "changed" ? null : "changed"))}
							title="Only what differs from the default"
							type="button">
							Changed <span className="opacity-70">{changed.length}</span>
						</button>
						{managed.length > 0 && (
							<button
								aria-pressed={filter === "managed"}
								className={cn(CHIP_CLASS, filter === "managed" && CHIP_ON_CLASS)}
								onClick={() => setFilter((current) => (current === "managed" ? null : "managed"))}
								title="What your organization manages"
								type="button">
								<i aria-hidden className="codicon codicon-lock text-[12px]!" />
								Managed <span className="opacity-70">{managed.length}</span>
							</button>
						)}
					</div>
				)}

				<div className="flex min-h-0 flex-1 overflow-hidden">
					{!setupIntro && (
						<TabList
							aria-label="Settings pages"
							aria-orientation="vertical"
							className={cn(
								"shrink-0 flex-col overflow-y-auto border-r border-editor-group-border",
								narrow ? "w-11" : "w-[172px]",
							)}
							onValueChange={selectPage}
							value={listing ? "" : pageId}>
							{pages.map((page) => (
								<PageTab
									count={trimmed ? hits.filter((row) => row.page === page.id).length : undefined}
									key={page.id}
									name={page.name}
									narrow={narrow}
									page={page.id}
									value={page.id}
								/>
							))}
						</TabList>
					)}

					<TabContent className="min-w-0">
						<div ref={topRef} />
						{listing && (
							<SettingsResults
								filter={filter}
								onClear={clearListing}
								onOpenPage={selectPage}
								query={trimmed}
								rows={listed}
							/>
						)}
						{pages
							.filter((page) => visited.has(page.id))
							.map((page) => {
								const { Component } = SETTINGS_PAGE_VIEWS[page.id]
								return (
									<div
										data-testid={`settings-page-${page.id}`}
										hidden={listing || page.id !== pageId}
										key={page.id}>
										<div className={cn("max-w-[760px] pt-4 pb-6", narrow ? "px-3.5" : "px-6")}>
											<h2 className="m-0 text-[16px] font-semibold">{page.name}</h2>
											<p className="m-0 mt-1 mb-2 text-[13px] text-description">{page.description}</p>
											<Component />
										</div>
									</div>
								)
							})}
						{pending && (
							<SettingsTargetHighlight
								key={pending.requestId}
								onComplete={completeTarget}
								requestId={pending.requestId}
								target={pending.target}
							/>
						)}
					</TabContent>
				</div>
			</Tab>
		</SettingsShellContext.Provider>
	)
}
