import type { CoreSessionEvent } from "@cline/core"

/** These block on a child, which runs on its own time. Its silence isn't the parent stalling. */
const WAITING_TOOLS = new Set(["spawn_agent", "wait_for_agents"])

/** Stops silent runtime stalls while allowing unbounded time for user decisions and for a child being waited on. */
export class TurnActivityWatchdog {
	private timer: ReturnType<typeof setTimeout> | undefined
	private readonly waitingCalls = new Set<string>()

	constructor(
		private readonly hasPendingDecision: () => boolean,
		private readonly onStall: () => void,
		private readonly timeoutMs = 120_000,
	) {}

	activity(): void {
		this.clearTimer()
		this.timer = setTimeout(() => {
			this.timer = undefined
			if (this.hasPendingDecision() || this.waitingCalls.size) this.activity()
			else this.onStall()
		}, this.timeoutMs)
		this.timer.unref?.()
	}

	/** Follows the parent's own tool calls, to know while one is waiting on a child. */
	observe(event: CoreSessionEvent): void {
		if (event.type !== "agent_event") return
		const tool = event.payload.event
		if ((tool.type !== "content_start" && tool.type !== "content_end") || tool.contentType !== "tool") return
		if (!WAITING_TOOLS.has(tool.toolName ?? "")) return
		const call = tool.toolCallId ?? tool.toolName ?? ""
		if (tool.type === "content_start") this.waitingCalls.add(call)
		else this.waitingCalls.delete(call)
	}

	stop(): void {
		this.clearTimer()
		this.waitingCalls.clear()
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}
}
