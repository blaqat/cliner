import type React from "react"
import { forwardRef } from "react"
import { cn } from "@/lib/utils"
import { ModelSelector, type ModelSelectorProps } from "./ModelSelector"
import { describePick } from "./modelSelectorRows"

/** The chip's codicon chevron, as on the other composer chips. */
export const ChipChevron = () => <span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />

// Text-only feedback: the chip brightens on hover, focus or open; no background highlight.
export const MODEL_CHIP_CLASS =
	"flex h-5 min-w-0 cursor-pointer items-center gap-[0.3em] rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description transition-colors duration-100 hover:text-foreground focus-visible:text-foreground motion-reduce:transition-none focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) data-[state=open]:text-foreground"

type ModelPickChipProps = Omit<React.ComponentPropsWithoutRef<"button">, "children"> & {
	model: string
	level?: string
	/** The saved level isn't one this model offers: it won't start until changed. */
	badLevel?: boolean
}

/** The compact trigger: "GPT-6 Sol Med ▾". Radix passes its open state and click through `props`. */
const ModelPickChip = forwardRef<HTMLButtonElement, ModelPickChipProps>(
	({ model, level, badLevel, className, ...props }, ref) => (
		<button className={cn(MODEL_CHIP_CLASS, "max-w-[230px]", className)} ref={ref} type="button" {...props}>
			<span className="min-w-[3ch] truncate">{model}</span>
			{level && <span className={cn("shrink-0 whitespace-nowrap", badLevel && "text-warning")}>{level}</span>}
			<ChipChevron />
		</button>
	),
)
ModelPickChip.displayName = "ModelPickChip"

interface ModelPickButtonProps extends Omit<ModelSelectorProps, "trigger" | "top" | "footer" | "align"> {
	className?: string
	/** The trigger's id, so a row's label and a fix link can reach it. */
	id?: string
}

/**
 * A settings row's model pick: the compact chip that opens the same selector as the composer, with
 * none of the composer's extras. With no models set up it still opens, to say so and link to the fix.
 */
export function ModelPickButton({ className, id, ...selector }: ModelPickButtonProps) {
	const { model, level, levelOffered } = describePick(selector.rows, selector.pick)
	return (
		<ModelSelector
			{...selector}
			align="end"
			trigger={
				<ModelPickChip
					aria-label={`${selector.modelsLabel}: ${model}${level ? ` ${level}` : ""}`}
					badLevel={!levelOffered}
					className={className}
					data-testid="model-pick-button"
					id={id}
					level={level}
					model={model}
				/>
			}
		/>
	)
}
