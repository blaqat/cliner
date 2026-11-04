import { type ReactNode, useState } from "react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { settingsRowControlId, settingsRowElementId } from "../settingsTargets"
import {
	findRow,
	isRowChanged,
	isRowManaged,
	isRowVisible,
	resetRow,
	rowDescription,
	rowDiffers,
	writeRow,
} from "./settingsRegistry"
import type { PreferenceRow, SettingsRow } from "./settingsRegistry"
import { useSettingsShell } from "./SettingsShellContext"

export const TAG_CLASS = "inline-flex h-4 items-center gap-0.5 whitespace-nowrap rounded-[3px] border px-1 text-[10px] leading-none"
export const RESET_CLASS =
	"cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline disabled:cursor-not-allowed disabled:text-description disabled:no-underline"

export const ManagedTag = () => (
	<span className={cn(TAG_CLASS, "border-warning/45 text-warning")}>
		<i aria-hidden className="codicon codicon-lock text-[10px]!" />
		Managed
	</span>
)

export const AdvancedTag = () => <span className={cn(TAG_CLASS, "border-editor-group-border text-description")}>Advanced</span>

const organizationName = (name: string | undefined) => name || "Your organization"

/** Changed + Reset, or the lock + Managed chip. Reset on a managed value stays visible but off, and says why. */
export const RowStatus = ({ row }: { row: SettingsRow }) => {
	const { rows, ctx } = useSettingsShell()
	if (isRowManaged(row, ctx)) {
		const owner = organizationName(ctx.activeOrganization?.name)
		return (
			<>
				<ManagedTag />
				{rowDiffers(row, ctx) && (
					<button
						className={RESET_CLASS}
						disabled
						title={`${owner} manages this, so Reset is off. Your own value comes back if that ends.`}
						type="button">
						Reset
					</button>
				)}
			</>
		)
	}
	if (!isRowChanged(row, ctx)) {
		return null
	}
	return (
		<>
			<span className={cn(TAG_CLASS, "border-link/40 text-link")}>Changed</span>
			<button
				aria-label={`Reset ${row.label}`}
				className={RESET_CLASS}
				onClick={() => resetRow(rows, row, ctx)}
				title="Back to the default"
				type="button">
				Reset
			</button>
		</>
	)
}

export interface RowControlProps<T> {
	id: string
	label: string
	disabled: boolean
	value: T
	write: (value: T) => void
}

interface SettingRowProps<T> {
	rowId: string
	control?: (props: RowControlProps<T>) => ReactNode
	/** Shown under the row, right where its Advanced fold belongs. */
	children?: ReactNode
}

const preferenceValue = <T,>(row: SettingsRow, ctx: Parameters<PreferenceRow["read"]>[0]) =>
	(row.kind === "preference" ? row.read(ctx) : undefined) as T

/** One settings row. Everything it shows besides the control comes from the registry. */
export const SettingRow = <T = unknown>({ rowId, control, children }: SettingRowProps<T>) => {
	const { rows, ctx } = useSettingsShell()
	const row = findRow(rows, rowId)
	if (!row || !isRowVisible(rows, row, ctx)) {
		return null
	}
	const managed = isRowManaged(row, ctx)
	const reason = row.disabledReason?.(ctx)
	const controlId = settingsRowControlId(row.id)
	const description = rowDescription(row, ctx)
	return (
		<div
			className="scroll-my-2 rounded-xs border-b border-editor-group-border py-2 last:border-b-0"
			data-row={row.id}
			id={row.elementId ?? settingsRowElementId(row.id)}>
			<div className="flex flex-wrap items-start justify-between gap-x-2.5 gap-y-1">
				<div className="min-w-[150px] flex-1">
					<div className="flex min-h-[18px] flex-wrap items-center gap-1.5">
						<label className="text-foreground" htmlFor={controlId}>
							{row.label}
						</label>
						<RowStatus row={row} />
					</div>
					{description && <div className="mt-px text-[11px] text-description">{description}</div>}
					{managed && (
						<div className="mt-1 flex items-start gap-1.5 text-[11px] text-description">
							<i aria-hidden className="codicon codicon-lock text-[11px]! text-warning" />
							<span>
								{organizationName(ctx.activeOrganization?.name)} manages this. Ask your admin to change it.
							</span>
						</div>
					)}
					{!managed && reason && <div className="mt-1 text-[11px] text-description">{reason}</div>}
				</div>
				{control && (
					<div className="flex min-h-[18px] shrink-0 items-center gap-1.5">
						{control({
							id: controlId,
							label: row.label,
							disabled: managed || !!reason,
							value: preferenceValue<T>(row, ctx),
							write: (value) => {
								if (row.kind === "preference") {
									writeRow(row, value, ctx)
								}
							},
						})}
					</div>
				)}
			</div>
			{children}
		</div>
	)
}

/** An anchor for a mounted older component, which brings its own labels. */
export const SettingBlock = ({ rowId, children }: { rowId: string; children: ReactNode }) => {
	const { rows, ctx } = useSettingsShell()
	const row = findRow(rows, rowId)
	if (!row || !isRowVisible(rows, row, ctx)) {
		return null
	}
	return (
		<div className="rounded-xs" data-row={row.id} id={row.elementId ?? settingsRowElementId(row.id)}>
			{children}
		</div>
	)
}

export const ToggleRow = <T = boolean>({
	rowId,
	isOn = (value) => value === true,
	toValue = (on) => on as T,
	children,
}: {
	rowId: string
	isOn?: (value: T) => boolean
	toValue?: (on: boolean) => T
	children?: ReactNode
}) => (
	<SettingRow<T>
		control={({ id, label, disabled, value, write }) => (
			<Switch
				aria-label={label}
				checked={isOn(value)}
				disabled={disabled}
				id={id}
				onCheckedChange={(on) => write(toValue(on))}
				size="lg"
			/>
		)}
		rowId={rowId}>
		{children}
	</SettingRow>
)

export const SelectRow = ({
	rowId,
	options,
	children,
}: {
	rowId: string
	options: readonly { value: string; label: string }[]
	children?: ReactNode
}) => (
	<SettingRow<string>
		control={({ id, label, disabled, value, write }) => (
			<Select disabled={disabled} onValueChange={write} value={value}>
				<SelectTrigger aria-label={label} className="h-6 w-auto min-w-[110px] max-w-[170px]" id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		)}
		rowId={rowId}>
		{children}
	</SettingRow>
)

/** Commits on blur or Enter. Text it can't use stays in the box with `invalid` beside it, until it's fixed. */
export const NumberRow = ({
	rowId,
	toText = String,
	parse,
	invalid,
	placeholder,
}: {
	rowId: string
	toText?: (value: number) => string
	/** The value to store, or undefined when the text isn't usable. */
	parse: (text: string) => number | undefined
	invalid: string
	placeholder?: string
}) => {
	const [draft, setDraft] = useState<string>()
	return (
		<SettingRow<number>
			control={({ id, label, disabled, value, write }) => {
				const text = draft ?? toText(value)
				const bad = draft !== undefined && parse(draft) === undefined
				const commit = () => {
					if (draft === undefined) {
						return
					}
					const next = parse(draft)
					if (next === undefined) {
						return
					}
					if (next !== value) {
						write(next)
					}
					setDraft(undefined)
				}
				return (
					<>
						{bad && (
							<span className="text-[11px] text-error" role="alert">
								{invalid}
							</span>
						)}
						<Input
							aria-invalid={bad}
							aria-label={label}
							className="h-6 w-16"
							disabled={disabled}
							id={id}
							onBlur={commit}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									commit()
								}
							}}
							placeholder={placeholder}
							value={text}
						/>
					</>
				)
			}}
			rowId={rowId}
		/>
	)
}
