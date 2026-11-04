import type { UserOrganization } from "@shared/proto/index.cline"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import {
	DEFAULT_SETTINGS_PAGE,
	parseSettingsTarget,
	type SettingsPageId,
	settingsRowControlId,
	settingsRowElementId,
} from "../settingsTargets"
import { modelOverrideRows } from "./modelOverrideRows"

export interface SettingsRowContext {
	state: ExtensionStateContextType
	activeOrganization: UserOrganization | null
	isDev: boolean
}

interface SettingsRowBase {
	/** Starts with the page id. Also the row's deep-link target. */
	id: string
	page: SettingsPageId
	label: string
	description?: string | ((ctx: SettingsRowContext) => string)
	/** Extra words search should find it by. */
	aliases?: readonly string[]
	/** The feature row this sits under, in that feature's Advanced fold. */
	parent?: string
	/** Remote config or `modelSettings.managed` names that lock this row. Only names the org schema can set. */
	managedKeys?: readonly string[]
	visible?: (ctx: SettingsRowContext) => boolean
	/** Why the control is off right now, when a parent feature or mode turns it off. */
	disabledReason?: (ctx: SettingsRowContext) => string | undefined
	/** Overrides for rows living inside a mounted older component. */
	elementId?: string
	focusElementId?: string
}

/** A leaf preference: the only kind Changed counts and Reset applies to. */
export interface PreferenceRow<T = unknown> extends SettingsRowBase {
	kind: "preference"
	defaultValue(ctx: SettingsRowContext): T
	read(ctx: SettingsRowContext): T
	write(value: T, ctx: SettingsRowContext): void | Promise<void>
	/** An explicit override that happens to equal what it inherits is still changed. Omit to compare values. */
	isOverride?(ctx: SettingsRowContext): boolean
	/** Omit to write the default back. */
	reset?(ctx: SettingsRowContext): void | Promise<void>
	format?(value: T): string
	/** Shows a preference owned by another row, like the Subagents default on Models. Counted once, on the owner. */
	mirrorOf?: string
}

/** A row search and navigation can find that holds no preference of its own: a button, an overlay link, stored state. */
export interface InfoRow extends SettingsRowBase {
	kind: "action" | "state"
}

export type SettingsRow = PreferenceRow | InfoRow

export interface SettingsPageMeta {
	id: SettingsPageId
	name: string
	description: string
	hidden?: (ctx: SettingsRowContext) => boolean
}

export const SETTINGS_PAGE_META: readonly SettingsPageMeta[] = [
	{ id: "models", name: "Models", description: "Every model you've set up, under where it runs." },
	{ id: "agent", name: "Agent", description: "How Cline works in a thread." },
	{ id: "subagents", name: "Subagents", description: "Helpers a thread can start." },
	{ id: "tools", name: "Tools", description: "What Cline can reach and run." },
	{ id: "layout", name: "Layout", description: "How the panel is arranged, and what pings you." },
	{ id: "data", name: "Data & privacy", description: "What's sent, what's kept." },
	{ id: "about", name: "About", description: "Version and help." },
	{ id: "debug", name: "Debug", description: "Development builds only.", hidden: (ctx) => !ctx.isDev },
]

const pageMeta = (id: SettingsPageId) => SETTINGS_PAGE_META.find((page) => page.id === id)

export const isPageVisible = (id: SettingsPageId, ctx: SettingsRowContext) => !pageMeta(id)?.hidden?.(ctx)

export const visiblePages = (ctx: SettingsRowContext) => SETTINGS_PAGE_META.filter((page) => isPageVisible(page.id, ctx))

export const findRow = (rows: readonly SettingsRow[], id: string) => rows.find((row) => row.id === id)

/** Nearest parent first. */
export const rowAncestors = (rows: readonly SettingsRow[], row: SettingsRow): SettingsRow[] => {
	const ancestors: SettingsRow[] = []
	let parent = row.parent ? findRow(rows, row.parent) : undefined
	while (parent && !ancestors.includes(parent)) {
		ancestors.push(parent)
		parent = parent.parent ? findRow(rows, parent.parent) : undefined
	}
	return ancestors
}

export const isRowVisible = (rows: readonly SettingsRow[], row: SettingsRow, ctx: SettingsRowContext): boolean =>
	isPageVisible(row.page, ctx) && [row, ...rowAncestors(rows, row)].every((entry) => entry.visible?.(ctx) ?? true)

export const rowDescription = (row: SettingsRow, ctx: SettingsRowContext) =>
	typeof row.description === "function" ? row.description(ctx) : row.description

const isLocked = (value: unknown) => value !== undefined && !(Array.isArray(value) && value.length === 0)

export const isRowManaged = (row: SettingsRow, ctx: SettingsRowContext): boolean => {
	const remote = ctx.state.remoteConfigSettings as Record<string, unknown> | undefined
	const hostManaged = ctx.state.modelSettings?.managed
	return !!row.managedKeys?.some((key) => isLocked(remote?.[key]) || hostManaged?.includes(key))
}

/** Whether the row differs from its default, whoever set it. */
export const rowDiffers = (row: SettingsRow, ctx: SettingsRowContext): boolean => {
	if (row.kind !== "preference") {
		return false
	}
	return row.isOverride?.(ctx) ?? JSON.stringify(row.read(ctx)) !== JSON.stringify(row.defaultValue(ctx))
}

/** Changed means the user's own change: a managed value isn't theirs and can't be reset. */
export const isRowChanged = (row: SettingsRow, ctx: SettingsRowContext) => rowDiffers(row, ctx) && !isRowManaged(row, ctx)

export const changedRows = (rows: readonly SettingsRow[], ctx: SettingsRowContext) => [
	...rows.filter((row) => row.kind === "preference" && !row.mirrorOf && isRowVisible(rows, row, ctx) && isRowChanged(row, ctx)),
	...modelOverrideRows(ctx),
]

export const managedRows = (rows: readonly SettingsRow[], ctx: SettingsRowContext) =>
	rows.filter((row) => isRowVisible(rows, row, ctx) && isRowManaged(row, ctx))

const reportFailure = (row: SettingsRow, error: unknown) => console.error(`Failed to update ${row.id}:`, error)

export const writeRow = (row: PreferenceRow, value: unknown, ctx: SettingsRowContext) => {
	try {
		void Promise.resolve(row.write(value, ctx)).catch((error) => reportFailure(row, error))
	} catch (error) {
		reportFailure(row, error)
	}
}

/** Never clears an org value: a managed row stays as it is, and any stored override comes back when management ends. */
export const resetRow = (rows: readonly SettingsRow[], row: SettingsRow, ctx: SettingsRowContext) => {
	if (row.kind !== "preference" || isRowManaged(row, ctx)) {
		return
	}
	const owner = row.mirrorOf ? findRow(rows, row.mirrorOf) : row
	if (owner?.kind !== "preference") {
		return
	}
	if (owner.reset) {
		try {
			void Promise.resolve(owner.reset(ctx)).catch((error) => reportFailure(owner, error))
		} catch (error) {
			reportFailure(owner, error)
		}
		return
	}
	writeRow(owner, owner.defaultValue(ctx), ctx)
}

export const formatRowValue = (row: PreferenceRow, value: unknown) => {
	if (row.format) {
		return row.format(value)
	}
	if (typeof value === "boolean") {
		return value ? "On" : "Off"
	}
	return value === null || value === undefined || value === "" ? "Not set" : String(value)
}

/** Every word has to appear in what the row says, its aliases, its page or the features above it. */
export const searchRows = (rows: readonly SettingsRow[], query: string, ctx: SettingsRowContext) => {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (!words.length) {
		return []
	}
	return rows.filter((row) => {
		if (!isRowVisible(rows, row, ctx)) {
			return false
		}
		const text = [
			row.label,
			rowDescription(row, ctx),
			...(row.aliases ?? []),
			pageMeta(row.page)?.name,
			...rowAncestors(rows, row).map((ancestor) => ancestor.label),
		]
			.join(" ")
			.toLowerCase()
		return words.every((word) => text.includes(word))
	})
}

export interface ShellTarget {
	pageId?: SettingsPageId
	/** Features whose Advanced folds have to open for the row to exist. */
	foldIds: string[]
	elementId?: string
	focusElementId?: string
}

/** Where a target lands, with the dev and admin gates applied. A gated target opens no hidden content. */
export const resolveShellTarget = (
	rows: readonly SettingsRow[],
	target: string | undefined,
	ctx: SettingsRowContext,
): ShellTarget | undefined => {
	const parsed = parseSettingsTarget(target)
	if (!parsed) {
		return undefined
	}
	if (parsed.pageId && !isPageVisible(parsed.pageId, ctx)) {
		return { pageId: DEFAULT_SETTINGS_PAGE, foldIds: [] }
	}
	const row = parsed.rowId ? findRow(rows, parsed.rowId) : undefined
	if (!row) {
		return { pageId: parsed.pageId, foldIds: [], elementId: parsed.elementId, focusElementId: parsed.focusElementId }
	}
	if (!isRowVisible(rows, row, ctx)) {
		return { pageId: row.page, foldIds: [] }
	}
	return {
		pageId: row.page,
		foldIds: rowAncestors(rows, row).map((ancestor) => ancestor.id),
		elementId: row.elementId ?? settingsRowElementId(row.id),
		focusElementId: row.focusElementId ?? settingsRowControlId(row.id),
	}
}
