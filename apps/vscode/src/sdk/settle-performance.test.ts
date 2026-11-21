import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SqliteSessionStore } from "@cline/core"
import { expect, it, vi } from "vitest"
import { Controller } from "./SdkController"
import { SdkTaskHistory } from "./sdk-task-history"
import { StatePostDebouncer } from "./state-post-debouncer"

vi.mock("@/services/telemetry", () => ({ telemetryService: {} }))
vi.mock("./legacy-state-reader", () => ({ readTaskHistory: () => [] }))
vi.mock("@core/controller/state/getStateToPostToWebview", () => ({ getStateToPostToWebview: async () => ({}) }))
// Real SQLite, 500 records, production projection and post scheduler. SETTLE_BENCH_BASELINE=1 replays the old loop.
it("benchmarks settling 1, 3, 5 and 10 threads", async () => {
	const rows: object[] = []
	for (const count of [1, 3, 5, 10]) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settle-perf-"))
		const store = new SqliteSessionStore({ sessionsDir: dir })
		for (let i = 0; i < 500; i++)
			store.create({
				sessionId: `thread-${i}`,
				source: "vscode",
				pid: 0,
				startedAt: new Date().toISOString(),
				status: "completed",
				interactive: true,
				provider: "test",
				model: "test",
				cwd: dir,
				workspaceRoot: dir,
				prompt: `Investigate workspace behavior ${i}`,
				metadata: { isSettled: false, size: 0, taskGroupId: `group-${Math.floor(i / 10)}`, lastActivityTs: Date.now() },
			} as never)
		let gets = 0,
			writes = 0,
			lists = 0,
			posts = 0,
			bytes = 0,
			writeMs = 0,
			projectionMs = 0
		const host = {
			get: async (id: string) => {
				gets++
				return store.get(id)
			},
			update: async (id: string, patch: object) => {
				const start = performance.now()
				writes++
				store.update({ sessionId: id, ...patch })
				writeMs += performance.now() - start
				return { updated: true }
			},
			listHistory: async () => {
				lists++
				return store.list(10000)
			},
		}
		const history = new SdkTaskHistory({
			databaseDir: dir,
			sessions: { getActiveSession: () => ({ sdkHost: host }) },
		} as never)
		const controller: any = {
			taskHistory: history,
			stateManager: { getGlobalSettingsKey: () => undefined, getRemoteConfigSettings: () => ({}) },
			foregroundCommands: { isRunning: false },
			ensureWorkspaceManager: async () => undefined,
			sessions: { getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => ({ epoch: 1, nextSeq: () => 1 }) },
			subagentThreads: new Map(),
			taskSessions: new Map(),
			getStateToPostToWebview: Controller.prototype.getStateToPostToWebview,
		}
		await controller.getStateToPostToWebview()
		lists = 0
		const debouncer = new StatePostDebouncer({
			debounceMs: 50,
			flush: async () => {
				const start = performance.now()
				const state = await controller.getStateToPostToWebview()
				bytes += Buffer.byteLength(JSON.stringify(state))
				posts++
				projectionMs += performance.now() - start
			},
		})
		controller.postStateToWebview = (immediate?: boolean) => debouncer.post(immediate)
		const start = performance.now()
		try {
			const batch = (Controller.prototype as any).setTasksSettled
			if (process.env.SETTLE_BENCH_BASELINE || !batch) {
				for (let i = 0; i < count; i++) {
					const id = `thread-${i}`
					const item = await history.findHistoryItem(id)
					await (history as any).updateOwnedMetadata(id, (metadata: any) => ({
						lastActivityTs: metadata.lastActivityTs ?? item?.ts,
						isSettled: true,
						settledAt: Date.now(),
						isStashed: false,
						stashedAt: 0,
					}))
					await controller.postStateToWebview()
				}
			} else
				await batch.call(
					controller,
					Array.from({ length: count }, (_, i) => `thread-${i}`),
					true,
				)
			const elapsed = performance.now() - start
			rows.push({
				threads: count,
				confirmedMs: +elapsed.toFixed(2),
				gets,
				writes,
				lists,
				posts,
				bytes,
				writeMs: +writeMs.toFixed(2),
				projectionMs: +projectionMs.toFixed(2),
			})
			expect(store.get("thread-0")?.metadata?.isSettled).toBe(true)
		} finally {
			await debouncer.dispose()
			await history.dispose()
			store.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	}
	process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
})
