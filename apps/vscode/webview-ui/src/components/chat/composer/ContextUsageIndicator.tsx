import type { Mode } from "@shared/storage/types"
import { FoldVerticalIcon } from "lucide-react"
import { memo, useState } from "react"
import { describeProfile } from "@/components/settings/apiProfiles/profileDraft"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useTaskCostVisible } from "@/hooks/useTaskCostVisible"
import { formatLargeNumber } from "@/utils/format"
import { CONTEXT_USAGE_COLORS, contextUsageLevel, contextUsagePercent, formatChatCost, showsCompactNudge } from "./contextUsage"
import { useFocusedChatModel } from "./useFocusedChatModel"

export interface ContextUsageIndicatorProps {
	/** Total tokens of the last request: what currently occupies the context window. */
	usedTokens?: number
	contextWindow?: number
	tokensIn: number
	tokensOut: number
	cacheReads?: number
	cacheWrites?: number
	/** Chat cost, or undefined when the provider's cost isn't meaningful. */
	cost?: number
	/** "Provider · model · API type" line for the details. */
	modelLabel: string
	/** Compaction is possible right now (not mid-turn, not already compacting, no recovery pending). */
	canCompact: boolean
	onCompact: () => void
	/** Narrow rows hide the cost text (it stays in the details). */
	showCost?: boolean
	/** Narrow rows drop the Compact pill; Compact stays in the details. */
	inlineCompactNudge?: boolean
}

const RING_SIZE = 18
const RING_STROKE = 2.5
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const ContextRing = ({ percent, color }: { percent: number; color: string }) => (
	<svg
		aria-hidden="true"
		className="shrink-0 -rotate-90"
		height={RING_SIZE}
		viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
		width={RING_SIZE}>
		<circle
			cx={RING_SIZE / 2}
			cy={RING_SIZE / 2}
			fill="none"
			r={RING_RADIUS}
			stroke="var(--vscode-input-border, var(--vscode-panel-border))"
			strokeWidth={RING_STROKE}
		/>
		<circle
			className="transition-[stroke-dashoffset,stroke] duration-300 motion-reduce:transition-none [.vscode-reduce-motion_&]:transition-none"
			cx={RING_SIZE / 2}
			cy={RING_SIZE / 2}
			data-testid="context-ring-progress"
			fill="none"
			r={RING_RADIUS}
			stroke={color}
			strokeDasharray={RING_CIRCUMFERENCE}
			strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
			strokeLinecap="round"
			strokeWidth={RING_STROKE}
		/>
	</svg>
)

const DetailRow = ({ label, value }: { label: string; value: string }) => (
	<div className="flex justify-between gap-3">
		<span className="text-description">{label}</span>
		<span className="text-right truncate min-w-0">{value}</span>
	</div>
)

/**
 * Composer bottom-row context meter: a ring of context used vs the model's window plus the chat's
 * cost. Clicking opens the token/cost details with a manual Compact; at high usage a Compact pill
 * appears in front of the ring.
 */
export const ContextUsageIndicator = memo(
	({
		usedTokens = 0,
		contextWindow,
		tokensIn,
		tokensOut,
		cacheReads,
		cacheWrites,
		cost,
		modelLabel,
		canCompact,
		onCompact,
		showCost = true,
		inlineCompactNudge = true,
	}: ContextUsageIndicatorProps) => {
		const [open, setOpen] = useState(false)
		const percent = contextUsagePercent(usedTokens, contextWindow)
		const level = contextUsageLevel(percent ?? 0)
		const costLabel = formatChatCost(cost)
		const roundedPercent = percent === undefined ? undefined : Math.round(percent)
		const summary = [roundedPercent === undefined ? "Context usage unknown" : `Context ${roundedPercent}% used`, costLabel]
			.filter(Boolean)
			.join(" · ")
		const nudge = showsCompactNudge(canCompact, percent)

		const compact = () => {
			setOpen(false)
			onCompact()
		}

		return (
			<div className="flex items-center gap-1 shrink-0" data-testid="context-usage">
				{nudge && inlineCompactNudge && (
					<button
						aria-label="Compact context"
						className="flex items-center gap-0.5 h-4.5 px-1.5 rounded-full border border-(--vscode-charts-yellow) bg-transparent text-xs text-foreground cursor-pointer hover:bg-toolbar-hover"
						data-testid="compact-nudge"
						onClick={compact}
						title="Context is nearly full. Compact the conversation to free up space."
						type="button">
						<FoldVerticalIcon size={11} />
						Compact
					</button>
				)}
				<Popover onOpenChange={setOpen} open={open}>
					<PopoverTrigger asChild>
						<button
							aria-label={summary}
							className="flex items-center gap-1 h-5 px-0.5 rounded-xs border-0 bg-transparent text-xs text-description cursor-pointer hover:bg-toolbar-hover hover:text-foreground"
							data-level={level}
							data-testid="context-usage-button"
							title={summary}
							type="button">
							<ContextRing color={CONTEXT_USAGE_COLORS[level]} percent={percent ?? 0} />
							{costLabel && showCost && (
								<span className="tabular-nums" data-testid="context-usage-cost">
									{costLabel}
								</span>
							)}
						</button>
					</PopoverTrigger>
					<PopoverContent align="end" className="w-64 text-xs flex flex-col gap-1" side="top">
						<div data-testid="context-usage-details">
							<DetailRow
								label="Context"
								value={
									contextWindow
										? `${formatLargeNumber(usedTokens)} / ${formatLargeNumber(contextWindow)} · ${roundedPercent}%`
										: `${formatLargeNumber(usedTokens)} / unknown`
								}
							/>
							<DetailRow
								label="Input / Output"
								value={`${formatLargeNumber(tokensIn)} / ${formatLargeNumber(tokensOut)}`}
							/>
							{(cacheReads || cacheWrites) && (
								<DetailRow
									label="Cache read / write"
									value={`${formatLargeNumber(cacheReads ?? 0)} / ${formatLargeNumber(cacheWrites ?? 0)}`}
								/>
							)}
							{costLabel && <DetailRow label="Cost (this chat)" value={costLabel} />}
							<DetailRow label="Model" value={modelLabel} />
						</div>
						<button
							className="self-end mt-1 px-2 py-0.5 rounded-xs border-0 bg-button-background text-button-foreground text-xs cursor-pointer hover:bg-button-hover disabled:cursor-not-allowed disabled:opacity-50"
							data-nudge={nudge}
							data-testid="compact-now-button"
							disabled={!canCompact}
							onClick={compact}
							title={
								canCompact
									? "Replace the history with a summary to free up context"
									: "Compaction is available between turns"
							}
							type="button">
							Compact now
						</button>
					</PopoverContent>
				</Popover>
			</div>
		)
	},
)
ContextUsageIndicator.displayName = "ContextUsageIndicator"

/**
 * The indicator's model-dependent props for the focused chat: the model it runs (a per-chat
 * override or its saved configuration's context window, not the Settings default) and whether
 * that provider's cost is meaningful.
 */
export function useComposerContextUsage(
	mode: Mode,
	totalCost: number | undefined,
): Pick<ContextUsageIndicatorProps, "contextWindow" | "cost" | "modelLabel"> {
	const model = useFocusedChatModel(mode)
	const costVisible = useTaskCostVisible(model, totalCost)
	return {
		contextWindow: model.contextWindow,
		cost: costVisible ? totalCost : undefined,
		modelLabel: describeProfile(model),
	}
}
