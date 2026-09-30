import type { TaskApiSelection } from "./api-profiles"

export type HistoryItem = {
	id: string
	ulid?: string // ULID for better tracking and metrics
	ts: number
	task: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number

	size?: number
	cwdOnTaskInitialization?: string
	conversationHistoryDeletedRange?: [number, number]
	isFavorited?: boolean
	isSettled?: boolean
	settledAt?: number
	parentTaskId?: string
	forkedAtTs?: number
	/** Total subagents ever spawned by this task (persisted for inbox counts). */
	subagentCount?: number

	modelId?: string
	/**
	 * Provider id the task ran on (from the SDK session record). Absent for
	 * tasks recorded before this field existed and for legacy imports —
	 * cost-display consumers treat an absent provider as "show", since
	 * there is nothing to key suppression on.
	 */
	apiProvider?: string
	/**
	 * Saved-configuration selection (profile ids + reasoning effort per mode)
	 * the task was last using, persisted in session metadata so reopening the
	 * chat restores it instead of the current global selection.
	 */
	apiSelection?: TaskApiSelection
	isLegacy?: boolean
}
