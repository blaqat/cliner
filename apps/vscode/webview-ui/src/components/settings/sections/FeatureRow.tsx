import { memo, type ReactNode } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { featureSettingControlId, featureSettingElementId } from "../settingsTargets"

// Reusable switch row for feature settings
interface FeatureRowProps {
	id?: string
	checked: boolean | undefined
	onChange: (checked: boolean) => void
	label: string
	description: ReactNode
	disabled?: boolean
	isRemoteLocked?: boolean
	remoteTooltip?: string
	isVisible?: boolean
}

export const FeatureRow = memo(
	({
		id,
		checked = false,
		onChange,
		label,
		description,
		disabled,
		isRemoteLocked,
		isVisible = true,
		remoteTooltip,
	}: FeatureRowProps) => {
		if (!isVisible) {
			return null
		}
		const switchId = id ? featureSettingControlId(id) : label

		const checkbox = (
			<div className="flex items-center justify-between w-full">
				<label htmlFor={switchId}>{label}</label>
				<div>
					<Switch
						checked={checked}
						className="shrink-0"
						disabled={disabled || isRemoteLocked}
						id={switchId}
						onCheckedChange={onChange}
						size="lg"
					/>
					{isRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
				</div>
			</div>
		)

		return (
			<div
				className="flex flex-col items-start justify-between gap-4 py-3 px-1 w-full rounded-xs border border-transparent"
				id={id ? featureSettingElementId(id) : undefined}>
				<div className="space-y-0.5 flex-1 w-full">
					{isRemoteLocked ? (
						<Tooltip>
							<TooltipTrigger asChild>{checkbox}</TooltipTrigger>
							<TooltipContent className="max-w-xs" side="top">
								{remoteTooltip}
							</TooltipContent>
						</Tooltip>
					) : (
						checkbox
					)}
				</div>
				<div className="text-xs text-description">{description}</div>
			</div>
		)
	},
)

/** A labelled field (select, text box) in a feature group: label, description, then the control. */
export const FeatureField = ({
	label,
	htmlFor,
	description,
	children,
	className,
}: {
	label: string
	htmlFor?: string
	description?: ReactNode
	children: ReactNode
	className?: string
}) => (
	<div className={cn("space-y-2 py-3 px-1", className)}>
		<Label className="text-sm font-medium text-foreground" htmlFor={htmlFor}>
			{label}
		</Label>
		{description && <p className="text-xs text-muted-foreground">{description}</p>}
		{children}
	</div>
)

/** A Features group: the small uppercase heading, an optional one-line description and the bordered card holding its rows. */
export const FeatureGroup = ({
	title,
	id,
	description,
	children,
	className,
	"aria-label": ariaLabel,
}: {
	title: string
	id: string
	description?: ReactNode
	children: ReactNode
	className?: string
	"aria-label"?: string
}) => (
	<div>
		<div className={cn("text-xs font-medium text-foreground/80 uppercase tracking-wider", description ? "mb-1" : "mb-3")}>
			{title}
		</div>
		{description && <p className="m-0 mb-3 text-xs text-description">{description}</p>}
		<section
			aria-label={ariaLabel}
			className={cn("relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50", className)}
			id={id}>
			{children}
		</section>
	</div>
)
