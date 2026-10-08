import { Logger } from "@/shared/services/Logger"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"

export type SessionRebuildReason = "provider" | "mcpTools" | "terminalExecutionMode" | "checkpoints" | "subagents"

export interface SdkSessionRebuildSchedulerOptions {
	sessions: Pick<SdkSessionLifecycle, "getActiveSession"> & Partial<Pick<SdkSessionLifecycle, "getSession">>
}

/**
 * A rebuild replaces the session, so it may only run between turns. Core
 * drains its own prompt queue the moment a turn ends, so a session with
 * queued prompts is about to run again: treat it as busy until Core has
 * emptied the queue.
 */
function isIdle(session: ReturnType<SdkSessionLifecycle["getActiveSession"]>): boolean {
	return session !== undefined && !session.isRunning && session.queuedPromptCount === 0
}

export interface SessionRebuildContext {
	/**
	 * True until a newer request for the same reason arrives. A superseded
	 * rebuild should stop before replacing the session, or leave work it has
	 * not yet started to the newer rebuild, which runs next in the same drain.
	 */
	isCurrent: () => boolean
}

interface ScheduledRebuild {
	run: (context: SessionRebuildContext) => Promise<void>
	generation: number
	sessionId?: string
	background: boolean
}

/** Serializes passive session rebuilds and drains them only while the session is idle (see isIdle). */
export class SdkSessionRebuildScheduler {
	private readonly pending = new Map<string, ScheduledRebuild>()
	private drainInFlight: Promise<void> | undefined
	private readonly latestGeneration = new Map<string, number>()

	constructor(private readonly options: SdkSessionRebuildSchedulerOptions) {}

	/**
	 * Queues a rebuild, replacing any queued rebuild for the same reason. A
	 * rebuild for the same reason that is already running is superseded: its
	 * context.isCurrent() turns false and this request runs after it.
	 */
	request(reason: SessionRebuildReason, run: (context: SessionRebuildContext) => Promise<void>, sessionId?: string): void {
		const background = sessionId !== undefined
		sessionId ??= this.options.sessions.getActiveSession()?.sessionId
		const key = `${sessionId ?? "focused"}:${reason}`
		const generation = (this.latestGeneration.get(key) ?? 0) + 1
		this.latestGeneration.set(key, generation)
		this.pending.set(key, { run, generation, sessionId, background })
		this.drainIfIdle()
	}

	async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		while (this.drainInFlight) {
			await this.drainInFlight
		}
		let resolveExclusive: () => void = () => {}
		const exclusive = new Promise<void>((resolve) => {
			resolveExclusive = resolve
		})
		this.drainInFlight = exclusive
		try {
			return await operation()
		} finally {
			resolveExclusive()
			if (this.drainInFlight === exclusive) {
				this.drainInFlight = undefined
			}
			this.drainIfIdle()
		}
	}

	/** Focus transitions preserve rebuilds belonging to retained sessions. */
	async runTaskTransition<T>(operation: () => Promise<T>): Promise<T> {
		return this.runExclusive(operation)
	}

	forgetSession(sessionId: string): void {
		for (const key of this.latestGeneration.keys()) {
			if (!key.startsWith(`${sessionId}:`)) continue
			this.pending.delete(key)
			this.latestGeneration.delete(key)
		}
	}

	sessionBecameIdle(): void {
		this.drainIfIdle()
	}

	private sessionFor(rebuild: ScheduledRebuild) {
		const focused = this.options.sessions.getActiveSession()
		if (!rebuild.sessionId) return focused
		if (!rebuild.background) return focused?.sessionId === rebuild.sessionId ? focused : undefined
		return (
			this.options.sessions.getSession?.(rebuild.sessionId) ??
			(focused?.sessionId === rebuild.sessionId ? focused : undefined)
		)
	}

	private nextIdleRebuild() {
		return [...this.pending.entries()].find(([, rebuild]) => isIdle(this.sessionFor(rebuild)))
	}

	private drainIfIdle(): void {
		if (this.drainInFlight || !this.nextIdleRebuild()) return
		const drain = async (): Promise<void> => {
			let next: ReturnType<SdkSessionRebuildScheduler["nextIdleRebuild"]>
			while ((next = this.nextIdleRebuild())) {
				const [key, rebuild] = next
				this.pending.delete(key)
				try {
					await rebuild.run({ isCurrent: () => rebuild.generation === this.latestGeneration.get(key) })
				} catch (error) {
					Logger.error(`[SdkController] Failed scheduled ${key} session rebuild:`, error)
				}
			}
		}
		this.drainInFlight = drain().finally(() => {
			this.drainInFlight = undefined
			this.drainIfIdle()
		})
	}
}
