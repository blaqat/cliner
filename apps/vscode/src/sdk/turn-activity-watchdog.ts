/** Stops silent runtime stalls while allowing unbounded time for user decisions. */
export class TurnActivityWatchdog {
	private timer: ReturnType<typeof setTimeout> | undefined

	constructor(
		private readonly hasPendingDecision: () => boolean,
		private readonly onStall: () => void,
		private readonly timeoutMs = 120_000,
	) {}

	activity(): void {
		this.stop()
		this.timer = setTimeout(() => {
			this.timer = undefined
			if (this.hasPendingDecision()) this.activity()
			else this.onStall()
		}, this.timeoutMs)
		this.timer.unref?.()
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}
}
