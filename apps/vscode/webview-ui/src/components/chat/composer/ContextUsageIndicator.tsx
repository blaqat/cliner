import type { CostBreakdownRow } from "@shared/getApiMetrics"
import type { Mode } from "@shared/storage/types"
import { FoldVerticalIcon } from "lucide-react"
import { memo, useState } from "react"
import { COMPOSER_MENU_SCROLL_CLASS } from "@/components/common/menuStyles"
import { describeProfile, PROVIDER_LABELS } from "@/components/settings/apiProfiles/profileDraft"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useTaskCostVisible } from "@/hooks/useTaskCostVisible"
import { cn } from "@/lib/utils"
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
	/** "Provider · model · API type", the tooltip on the window line. */
	modelLabel: string
	/** The focused chat's model, named on the window line. */
	modelId?: string
	/** Usage and cost per model, subagents and earlier requests (`getCostBreakdown`). */
	breakdown?: CostBreakdownRow[]
	/** Auto-compaction is on (Settings); draws its point on the bar. */
	autoCompact?: boolean
	/** Compaction is possible right now (not mid-turn, not already compacting, no recovery pending). */
	canCompact: boolean
	onCompact: () => void
	/** Narrow rows hide the cost text (it stays in the details). */
	showCost?: boolean
	/** Narrow rows show the Compact pill as its icon alone. */
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

/** Matches the SDK's auto-compaction trigger (COMPACTION_TRIGGER_RATIO). */
const AUTO_COMPACT_PERCENT = 90

/** Theme chart colors for the cost rows, in order; subagents and earlier requests get their own. */
const MODEL_COLORS = [
	"var(--vscode-charts-purple)",
	"var(--vscode-charts-blue)",
	"var(--vscode-charts-orange)",
	"var(--vscode-charts-green)",
]
const SUBAGENT_COLOR = "var(--vscode-charts-yellow)"
const EARLIER_COLOR = "var(--vscode-descriptionForeground)"

const SECTION_LABEL = "text-[10.5px] font-semibold uppercase tracking-wider text-description"

const rowColor = (row: CostBreakdownRow, modelIndex: number) =>
	row.kind === "subagents"
		? SUBAGENT_COLOR
		: row.kind === "earlier"
			? EARLIER_COLOR
			: MODEL_COLORS[modelIndex % MODEL_COLORS.length]

const rowName = (row: CostBreakdownRow) =>
	row.kind === "subagents" ? "Subagents" : row.kind === "earlier" ? "Earlier requests" : (row.modelId ?? "Model")

const rowDetail = (row: CostBreakdownRow) =>
	[
		row.kind === "model" && row.providerId ? (PROVIDER_LABELS[row.providerId] ?? row.providerId) : undefined,
		row.kind === "earlier" ? "model not recorded" : undefined,
		`${formatLargeNumber(row.tokensIn)} in`,
		`${formatLargeNumber(row.tokensOut)} out`,
	]
		.filter(Boolean)
		.join(" · ")

/** One meter-style bar; `marker` draws a tick (the auto-compact point) on the track. */
const Bar = ({
	segments,
	marker,
	height = 6,
}: {
	segments: { width: number; color: string }[]
	marker?: number
	height?: number
}) => (
	<div className="relative" style={{ height }}>
		<div className="flex h-full overflow-hidden rounded-full bg-(--vscode-input-border,var(--vscode-panel-border))">
			{segments.map((segment, index) => (
				<span
					className="h-full transition-[width] duration-300 motion-reduce:transition-none"
					key={index}
					style={{ width: `${segment.width}%`, background: segment.color }}
				/>
			))}
		</div>
		{marker !== undefined && (
			<span
				aria-hidden
				className="absolute -top-[3px] -bottom-[3px] w-[2px] rounded-full bg-foreground/60"
				data-testid="auto-compact-marker"
				style={{ left: `${marker}%` }}
			/>
		)}
	</div>
)

/**
 * Composer bottom-row context meter: a ring of context used vs the model's window plus the chat's
 * cost. Clicking opens one card: how full the window is, the cost by model, and Compact. At high
 * usage a Compact pill appears in front of the ring; narrow rows keep it as its icon.
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
		modelId,
		breakdown = [],
		autoCompact = true,
		canCompact,
		onCompact,
		showCost = true,
		inlineCompactNudge = true,
	}: ContextUsageIndicatorProps) => {
		const [open, setOpen] = useState(false)
		const [tokensOpen, setTokensOpen] = useState(false)
		const percent = contextUsagePercent(usedTokens, contextWindow)
		const level = contextUsageLevel(percent ?? 0)
		const levelColor = CONTEXT_USAGE_COLORS[level]
		const costLabel = formatChatCost(cost)
		const roundedPercent = percent === undefined ? undefined : Math.round(percent)
		const summary = [roundedPercent === undefined ? "Context usage unknown" : `Context ${roundedPercent}% used`, costLabel]
			.filter(Boolean)
			.join(" · ")
		const nudge = showsCompactNudge(canCompact, percent)
		// Rows show cost only when the provider's cost means something (the same rule as the total).
		const withCost = costLabel !== undefined
		const breakdownTotal = breakdown.reduce((sum, row) => sum + row.cost, 0)
		let modelIndex = 0
		const rows = breakdown.map((row) => ({ row, color: rowColor(row, row.kind === "model" ? modelIndex++ : 0) }))
		const roomBeforeAuto =
			contextWindow && percent !== undefined && percent < AUTO_COMPACT_PERCENT
				? (contextWindow * AUTO_COMPACT_PERCENT) / 100 - usedTokens
				: undefined

		const compact = () => {
			setOpen(false)
			onCompact()
		}

		return (
			<div className="flex items-center gap-1 shrink-0" data-testid="context-usage">
				{nudge && (
					<button
						aria-label="Compact context"
						className={cn(
							"flex items-center justify-center gap-0.5 h-4.5 rounded-full border border-(--vscode-charts-yellow) bg-transparent text-xs text-foreground cursor-pointer hover:bg-toolbar-hover",
							inlineCompactNudge ? "px-1.5" : "w-4.5 shrink-0 px-0",
						)}
						data-icon-only={inlineCompactNudge ? undefined : "true"}
						data-testid="compact-nudge"
						onClick={compact}
						title="Context is nearly full. Compact the conversation to free up space."
						type="button">
						<FoldVerticalIcon size={11} />
						{inlineCompactNudge && "Compact"}
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
							<ContextRing color={levelColor} percent={percent ?? 0} />
							{costLabel && showCost && (
								<span className="tabular-nums" data-testid="context-usage-cost">
									{costLabel}
								</span>
							)}
						</button>
					</PopoverTrigger>
					<PopoverContent
						align="end"
						className={cn("w-[296px] max-w-[calc(100vw-1.5rem)] p-0 text-xs", COMPOSER_MENU_SCROLL_CLASS)}
						data-testid="context-usage-details"
						side="top">
						<section aria-label="Context" className="px-3 py-2.5" data-testid="context-usage-context">
							<div className="flex items-baseline justify-between gap-2">
								<span className={SECTION_LABEL}>Context</span>
								<span className="text-[11px] text-description tabular-nums">
									{contextWindow
										? `${formatLargeNumber(usedTokens)} of ${formatLargeNumber(contextWindow)}`
										: `${formatLargeNumber(usedTokens)} used`}
								</span>
							</div>
							{roundedPercent !== undefined ? (
								<>
									<div className="mt-0.5 mb-1.5 flex items-baseline justify-between gap-2">
										<span
											className="text-[20px] leading-tight font-semibold tabular-nums"
											style={{ color: levelColor }}>
											{roundedPercent}%
										</span>
										{modelId && (
											<span className="min-w-0 truncate text-[11px] text-description" title={modelLabel}>
												{modelId} window
											</span>
										)}
									</div>
									<Bar
										marker={autoCompact ? AUTO_COMPACT_PERCENT : undefined}
										segments={[{ width: percent ?? 0, color: levelColor }]}
									/>
									<div className="mt-1.5 text-[11px] text-description" data-testid="context-usage-auto">
										{!autoCompact
											? "Auto-compact is off"
											: roomBeforeAuto !== undefined
												? `${formatLargeNumber(Math.max(0, roomBeforeAuto))} left before auto-compact (${AUTO_COMPACT_PERCENT}%)`
												: "Auto-compacts before the next request"}
									</div>
								</>
							) : (
								<div className="mt-1 text-[11px] text-description">
									The window size of {modelId ?? "this model"} is unknown.
								</div>
							)}
						</section>

						<section
							aria-label={withCost ? "Cost" : "Usage"}
							className="border-t border-solid border-x-0 border-b-0 border-editor-group-border px-3 py-2.5"
							data-testid="context-usage-cost-section">
							<div className="flex items-baseline justify-between gap-2">
								<span className={SECTION_LABEL}>{withCost ? "Cost · this thread" : "Usage · this thread"}</span>
								{withCost && <span className="font-semibold tabular-nums">{costLabel}</span>}
							</div>
							{withCost && rows.length > 1 && breakdownTotal > 0 && (
								<div className="mt-2 mb-1">
									<Bar
										height={4}
										segments={rows.map(({ row, color }) => ({
											width: (row.cost / breakdownTotal) * 100,
											color,
										}))}
									/>
								</div>
							)}
							{rows.length === 0 ? (
								<div className="mt-1 text-[11px] text-description">No requests yet.</div>
							) : (
								<ul className="m-0 mt-1 list-none p-0">
									{rows.map(({ row, color }) => (
										<li
											className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-x-2 py-1 [&+&]:border-t [&+&]:border-dashed [&+&]:border-x-0 [&+&]:border-b-0 [&+&]:border-editor-group-border"
											data-testid="cost-breakdown-row"
											key={row.key}>
											<span
												aria-hidden
												className="mt-[5px] h-[8px] w-[8px] rounded-[2px]"
												style={{ background: color }}
											/>
											<span className="min-w-0">
												<span className="block truncate text-foreground" title={rowName(row)}>
													{rowName(row)}
												</span>
												<span className="block truncate text-[11px] text-description">
													{rowDetail(row)}
												</span>
											</span>
											{withCost && (
												<span className="text-right tabular-nums">
													<span className="block">{formatChatCost(row.cost) ?? "$0.00"}</span>
													{rows.length > 1 && breakdownTotal > 0 && (
														<span className="block text-[11px] text-description">
															{Math.round((row.cost / breakdownTotal) * 100)}%
														</span>
													)}
												</span>
											)}
										</li>
									))}
								</ul>
							)}
							<button
								aria-expanded={tokensOpen}
								className="mt-1 flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[11px] text-description hover:text-foreground"
								data-testid="context-usage-token-toggle"
								onClick={() => setTokensOpen(!tokensOpen)}
								type="button">
								<span
									aria-hidden
									className={`codicon codicon-chevron-${tokensOpen ? "down" : "right"} text-[11px]!`}
								/>
								Token details
							</button>
							{tokensOpen && (
								<dl
									className="m-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]"
									data-testid="context-usage-tokens">
									<dt className="text-description">Input</dt>
									<dd className="m-0 text-right tabular-nums">{formatLargeNumber(tokensIn)}</dd>
									<dt className="text-description">Output</dt>
									<dd className="m-0 text-right tabular-nums">{formatLargeNumber(tokensOut)}</dd>
									{(cacheReads || cacheWrites) && (
										<>
											<dt className="text-description">Cache read</dt>
											<dd className="m-0 text-right tabular-nums">{formatLargeNumber(cacheReads ?? 0)}</dd>
											<dt className="text-description">Cache write</dt>
											<dd className="m-0 text-right tabular-nums">{formatLargeNumber(cacheWrites ?? 0)}</dd>
										</>
									)}
								</dl>
							)}
						</section>

						<section className="border-t border-solid border-x-0 border-b-0 border-editor-group-border px-3 py-2.5">
							<Button
								className="h-6 w-full gap-1.5"
								data-nudge={nudge}
								data-testid="compact-now-button"
								disabled={!canCompact}
								onClick={compact}
								size="xs"
								// The primary button style: secondary blends into the menu on some themes.
								variant="default">
								<FoldVerticalIcon size={12} />
								Compact now
							</Button>
							{canCompact && (
								<div className="mt-1.5 text-center text-[11px] text-description">
									Summarizes the history to free up context
								</div>
							)}
						</section>
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
): Pick<ContextUsageIndicatorProps, "contextWindow" | "cost" | "modelLabel" | "modelId"> {
	const model = useFocusedChatModel(mode)
	const costVisible = useTaskCostVisible(model, totalCost)
	return {
		contextWindow: model.contextWindow,
		cost: costVisible ? totalCost : undefined,
		modelLabel: describeProfile(model),
		modelId: model.modelId || undefined,
	}
}
