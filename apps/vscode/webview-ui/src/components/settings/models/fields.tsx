import type { ReactNode } from "react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { RESET_CLASS, TAG_CLASS } from "../shell/SettingRow"

export const LINK_CLASS =
	"inline-flex cursor-pointer items-center gap-[3px] whitespace-nowrap border-0 bg-transparent p-0 text-[11px] text-link hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:text-description disabled:no-underline"

export const LinkButton = ({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button className={cn(LINK_CLASS, className)} type="button" {...props} />
)

export const SmallButton = ({
	primary,
	danger,
	className,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; danger?: boolean }) => (
	<Button
		className={cn(
			"h-[22px] gap-1 rounded-xs px-2.5 py-0 text-[11.5px]",
			danger && "bg-error/30 text-foreground hover:bg-error/40",
			className,
		)}
		type="button"
		variant={primary ? "default" : "secondary"}
		{...props}
	/>
)

export const Icon = ({ name, className }: { name: string; className?: string }) => (
	<i aria-hidden className={cn("codicon shrink-0 text-[12px]!", `codicon-${name}`, className)} />
)

export const Chevron = ({ open }: { open: boolean }) => (
	<Icon className="text-description" name={open ? "chevron-down" : "chevron-right"} />
)

export const Hint = ({ children, error, id }: { children: ReactNode; error?: boolean; id?: string }) => (
	<div
		className={cn("mt-0.5 text-[10.5px] opacity-80", error ? "text-error opacity-100" : "text-description")}
		id={id}
		role={error ? "alert" : undefined}>
		{children}
	</div>
)

export const Status = ({
	tone,
	icon,
	children,
	title,
}: {
	tone?: "ok" | "warn" | "bad"
	icon: string
	children: ReactNode
	title?: string
}) => (
	<span
		className={cn(
			"inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px]",
			tone === "ok"
				? "text-success"
				: tone === "warn"
					? "text-warning"
					: tone === "bad"
						? "text-error"
						: "text-description",
		)}
		title={title}>
		<Icon className="text-[11px]!" name={icon} />
		{children}
	</span>
)

export const Notice = ({
	tone,
	icon = "warning",
	children,
}: {
	tone: "warn" | "bad" | "info"
	icon?: string
	children: ReactNode
}) => (
	<div
		className={cn(
			"my-1.5 flex items-start gap-2 rounded-[5px] border px-2 py-1.5 text-[11.5px]",
			tone === "warn"
				? "border-warning/40 bg-warning/10"
				: tone === "bad"
					? "border-error/40 bg-error/10"
					: "border-(--vscode-focusBorder)/40 bg-(--vscode-focusBorder)/10",
		)}
		role={tone === "info" ? "status" : "alert"}>
		<Icon
			className={cn("mt-px", tone === "warn" ? "text-warning" : tone === "bad" ? "text-error" : "text-link")}
			name={icon}
		/>
		<div className="min-w-0 flex-1">{children}</div>
	</div>
)

/** A line under a row or control that says why, with the way out in it. */
export const Why = ({ tone, children }: { tone?: "warn" | "bad"; children: ReactNode }) => (
	<div
		className={cn("mt-1 flex items-start gap-1.5 text-[11px]", tone === "bad" ? "text-error" : "text-description")}
		role={tone === "bad" ? "alert" : undefined}>
		<Icon className={cn("mt-px text-[11px]!", tone === "warn" && "text-warning")} name={tone ? "warning" : "info"} />
		<span className="min-w-0">{children}</span>
	</div>
)

/** Changed + Reset on a model's own value. Reset deletes it, so the model follows the connection again. */
export const OverrideTag = ({ label, onReset }: { label: string; onReset: () => void }) => (
	<>
		<span className={cn(TAG_CLASS, "border-link/40 text-link")}>Changed</span>
		<button
			aria-label={`Reset ${label}`}
			className={RESET_CLASS}
			onClick={onReset}
			title="Follow the connection again"
			type="button">
			Reset
		</button>
	</>
)

export const LockedIcon = ({ title }: { title: string }) => (
	<span title={title}>
		<Icon className="text-[11px]! text-warning" name="lock" />
	</span>
)

export const Field = ({
	label,
	tag,
	hint,
	error,
	id,
	className,
	children,
}: {
	label: ReactNode
	tag?: ReactNode
	hint?: ReactNode
	error?: string
	id?: string
	className?: string
	children: ReactNode
}) => (
	<div className={cn("min-w-0 scroll-my-2 rounded-xs", className)} id={id}>
		<div className="mb-0.5 flex min-h-4 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-description">
			<span>{label}</span>
			{tag}
		</div>
		{children}
		{error ? <Hint error>{error}</Hint> : hint ? <Hint>{hint}</Hint> : null}
	</div>
)

export const FieldGrid = ({ children, className }: { children: ReactNode; className?: string }) => (
	<div className={cn("mt-1.5 grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-x-2.5 gap-y-2", className)}>
		{children}
	</div>
)

export type CommitResult = string | undefined | void

/**
 * A text box that writes on blur or Enter; Escape puts it back. Writing per keystroke would save half
 * a URL. If the write is refused the text stays with the reason under it until it's fixed.
 */
export const CommitInput = ({
	value,
	onCommit,
	mono,
	unknown,
	secret,
	label,
	placeholder,
	disabled,
	id,
	className,
	clearAfterCommit,
}: {
	value: string
	onCommit: (text: string) => CommitResult | Promise<CommitResult>
	mono?: boolean
	/** The placeholder says this value isn't known. */
	unknown?: boolean
	secret?: boolean
	label: string
	placeholder?: string
	disabled?: boolean
	id?: string
	className?: string
	clearAfterCommit?: boolean
}) => {
	const [draft, setDraft] = useState<string>()
	const [error, setError] = useState<string>()
	const commit = async () => {
		if (draft === undefined) {
			return
		}
		if (draft === value) {
			setDraft(undefined)
			setError(undefined)
			return
		}
		const text = draft
		const result = await onCommit(text)
		if (result) {
			setError(result)
			return
		}
		setError(undefined)
		setDraft((current) => (current === text ? undefined : current))
		if (clearAfterCommit) {
			setDraft(undefined)
		}
	}
	return (
		<div className="min-w-0">
			<Input
				aria-invalid={!!error}
				aria-label={label}
				autoComplete="off"
				className={cn(
					"h-6 rounded-xs px-[7px] py-0 text-[11.5px] md:text-[11.5px]",
					mono && "font-mono text-[11px] md:text-[11px]",
					unknown && "placeholder:text-warning",
					error && "border-error",
					className,
				)}
				disabled={disabled}
				id={id}
				onBlur={commit}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						void commit()
					} else if (event.key === "Escape") {
						setDraft(undefined)
						setError(undefined)
					}
				}}
				placeholder={placeholder}
				spellCheck={false}
				type={secret ? "password" : "text"}
				value={draft ?? value}
			/>
			{error && <Hint error>{error}</Hint>}
		</div>
	)
}

/** A choice of a few, shown whole. `inherited` marks the current one as coming from the connection. */
export const Segmented = <T extends string>({
	value,
	options,
	onChange,
	label,
	disabled,
	inherited,
	controlId,
	wrap,
}: {
	value: T | null
	options: readonly { value: T; label: string; warn?: boolean }[]
	onChange: (value: T) => void
	label: string
	disabled?: boolean
	inherited?: boolean
	/** The chosen button's id, for a fix link to focus. */
	controlId?: string
	wrap?: boolean
}) => (
	<div
		aria-label={label}
		className={cn(
			"inline-flex shrink-0 overflow-hidden rounded-xs border border-editor-group-border text-[11px]",
			wrap && "flex-wrap",
		)}
		role="radiogroup">
		{options.map((option, index) => {
			const on = option.value === value
			return (
				<button
					aria-checked={on}
					className={cn(
						"cursor-pointer border-0 bg-transparent px-2 py-0.5 text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed",
						index > 0 && "border-l border-solid border-editor-group-border",
						on &&
							(option.warn
								? "bg-warning/20 text-warning hover:text-warning"
								: inherited
									? "bg-button-background/40 text-foreground"
									: "bg-button-background text-button-foreground hover:text-button-foreground"),
					)}
					disabled={disabled}
					id={on ? controlId : undefined}
					key={option.value}
					onClick={() => !on && onChange(option.value)}
					role="radio"
					title={on && inherited ? "From this connection's shared defaults" : undefined}
					type="button">
					{option.label}
				</button>
			)
		})}
	</div>
)

export const KNOWLEDGE_OPTIONS = [
	{ value: "yes", label: "Yes" },
	{ value: "no", label: "No" },
	{ value: "unknown", label: "Unknown", warn: true },
] as const

/** One setting on one line: what it is on the left, the control on the right. Wraps in a narrow panel. */
export const ControlRow = ({
	label,
	description,
	tag,
	id,
	children,
}: {
	label: ReactNode
	description?: ReactNode
	tag?: ReactNode
	id?: string
	children: ReactNode
}) => (
	<div className="flex scroll-my-2 flex-wrap items-center justify-between gap-x-2.5 gap-y-1 rounded-xs py-[5px]" id={id}>
		<div className="min-w-[110px] flex-1">
			<div className="flex flex-wrap items-center gap-1.5 text-[12px]">
				<span>{label}</span>
				{tag}
			</div>
			{description && <div className="text-[11px] text-description">{description}</div>}
		</div>
		{children}
	</div>
)

export const SmallSwitch = ({
	checked,
	onChange,
	label,
	disabled,
	id,
	title,
}: {
	checked: boolean
	onChange: (checked: boolean) => void
	label: string
	disabled?: boolean
	id?: string
	title?: string
}) => (
	<Switch aria-label={label} checked={checked} disabled={disabled} id={id} onCheckedChange={onChange} size="lg" title={title} />
)

export const FoldHeader = ({
	open,
	onToggle,
	title,
	summary,
	badge,
}: {
	open: boolean
	onToggle: () => void
	title: string
	summary?: string
	badge?: ReactNode
}) => (
	<button
		aria-expanded={open}
		className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent px-0 pt-[7px] pb-[5px] text-left text-[11.5px] text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
		onClick={onToggle}
		type="button">
		<Chevron open={open} />
		<span className="shrink-0 font-medium text-foreground">{title}</span>
		{!open && summary && <span className="min-w-0 flex-1 truncate text-[11px] opacity-70">{summary}</span>}
		{badge}
	</button>
)

export const GroupHeading = ({ children }: { children: ReactNode }) => (
	<div className="pt-[9px] pb-px text-[10px] uppercase tracking-[0.06em] text-description opacity-80">{children}</div>
)

/** Positive whole numbers, the shape the host wants for tokens. Empty is `null`. */
export const parseTokens = (text: string): { value: number | null } | { error: string } => {
	const trimmed = text.trim().replaceAll(",", "")
	if (!trimmed) {
		return { value: null }
	}
	const value = Number(trimmed)
	return Number.isSafeInteger(value) && value > 0 ? { value } : { error: "Has to be a whole number above 0." }
}

/** A timeout typed in seconds, as milliseconds. Empty is `null`. */
export const parseSeconds = (text: string): { value: number | null } | { error: string } => {
	const trimmed = text.trim()
	if (!trimmed) {
		return { value: null }
	}
	const value = Math.round(Number(trimmed) * 1000)
	return Number.isSafeInteger(value) && value > 0 ? { value } : { error: "A number of seconds, above 0." }
}

/** Prices and temperature: any number from 0 up. Empty is `null`. */
export const parseAmount = (text: string): { value: number | null } | { error: string } => {
	const trimmed = text.trim()
	if (!trimmed) {
		return { value: null }
	}
	const value = Number(trimmed)
	return Number.isFinite(value) && value >= 0 ? { value } : { error: "Has to be a number." }
}
