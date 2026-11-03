import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SqliteSessionStore } from "@cline/core"
import { describe, expect, it, vi } from "vitest"
import { Controller as SdkController } from "./SdkController"
import { SdkTaskHistory } from "./sdk-task-history"

vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureRemoteConfigSessionGate: vi.fn(),
		captureMentionUsed: vi.fn(),
		captureMentionFailed: vi.fn(),
	},
}))

const { buildBaseStateMock } = vi.hoisted(() => ({
	buildBaseStateMock: vi.fn(async () => ({ taskHistory: [] })),
}))
vi.mock("@core/controller/state/getStateToPostToWebview", () => ({
	getStateToPostToWebview: buildBaseStateMock,
}))

vi.mock("./legacy-state-reader", () => ({ readTaskHistory: () => [] }))

describe("history projection cache", () => {
	async function fixture() {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-cache-"))
		const store = new SqliteSessionStore({ sessionsDir: dir })
		const create = (id: string, extra: Record<string, unknown> = {}) =>
			store.create({
				sessionId: id,
				source: "vscode",
				pid: 0,
				startedAt: new Date().toISOString(),
				status: "completed",
				interactive: true,
				provider: "test",
				model: "test",
				cwd: dir,
				workspaceRoot: dir,
				prompt: `Task ${id}`,
				metadata: { size: 0 },
				...extra,
			} as never)
		create("root")
		const host = {
			listHistory: vi.fn(async () => store.list(10000)),
			get: async (id: string) => store.get(id),
			update: async (id: string, patch: Record<string, unknown>) => {
				store.update({ sessionId: id, ...patch })
				return { updated: true }
			},
			delete: async (id: string) => store.delete(id),
		}
		const history = new SdkTaskHistory({
			databaseDir: dir,
			sessions: { getActiveSession: () => ({ sdkHost: host }) },
		} as never)
		const list = vi.spyOn(history, "listHistory")
		const controller: any = {
			stateManager: { getGlobalSettingsKey: () => undefined, getRemoteConfigSettings: () => ({}), setGlobalState: vi.fn() },
			foregroundCommands: { isRunning: false },
			ensureWorkspaceManager: async () => undefined,
			taskHistory: history,
			sessions: { getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => ({ epoch: 1, nextSeq: () => 1 }) },
			subagentThreads: new Map(),
			taskSessions: new Map(),
			getStateToPostToWebview: SdkController.prototype.getStateToPostToWebview,
		}
		return {
			controller,
			history,
			store,
			create,
			list,
			close: async () => {
				await history.dispose()
				store.close()
				await fs.rm(dir, { recursive: true, force: true })
			},
		}
	}
	it("reuses the processed array and skips listHistory on a settings-only post", async () => {
		const f = await fixture()
		try {
			const first = await f.controller.getStateToPostToWebview()
			f.controller.stateManager.setGlobalState("oneViewEnabled", true)
			const second = await f.controller.getStateToPostToWebview()
			expect(second.taskHistory).toBe(first.taskHistory)
			expect(f.list).toHaveBeenCalledTimes(1)
		} finally {
			await f.close()
		}
	})
	it("keeps unchanged history cached after the metadata TTL", async () => {
		const f = await fixture()
		try {
			const first = await f.controller.getStateToPostToWebview()
			const now = Date.now()
			const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000)
			try {
				expect((await f.controller.getStateToPostToWebview()).taskHistory).toBe(first.taskHistory)
				expect(f.list).toHaveBeenCalledTimes(1)
			} finally {
				clock.mockRestore()
			}
		} finally {
			await f.close()
		}
	})

	it("detects an external database write that bypasses the process counter", async () => {
		const f = await fixture()
		try {
			const first = await f.controller.getStateToPostToWebview()
			f.store.getRawDb().prepare("UPDATE sessions SET prompt = ? WHERE session_id = ?").run("External prompt", "root")
			const second = await f.controller.getStateToPostToWebview()
			expect(second.taskHistory[0].task).toBe("External prompt")
			expect(second.taskHistory).not.toBe(first.taskHistory)
		} finally {
			await f.close()
		}
	})

	it("observes writes from a different store connection, but ignores reads", async () => {
		const f = await fixture()
		const writer = new SqliteSessionStore({ sessionsDir: path.dirname(f.store.sessionDbPath()) })
		try {
			const first = await f.controller.getStateToPostToWebview()
			writer.get("root")
			expect((await f.controller.getStateToPostToWebview()).taskHistory).toBe(first.taskHistory)
			writer.update({ sessionId: "root", metadata: { size: 0, threadTitle: "Other writer" } })
			const second = await f.controller.getStateToPostToWebview()
			expect(second.taskHistory).not.toBe(first.taskHistory)
			expect(second.taskHistory[0].title).toBe("Other writer")
		} finally {
			writer.close()
			await f.close()
		}
	})

	const cases = [
		"rename",
		"stash",
		"settle",
		"tags",
		"group",
		"save",
		"usage",
		"status",
		"delete",
		"deleteAll",
		"new thread",
		"subagent spawn",
		"import",
		"live subagent",
	] as const
	it.each(cases)("immediately invalidates after %s", async (kind) => {
		const f = await fixture()
		try {
			const first = await f.controller.getStateToPostToWebview()
			const item = first.taskHistory[0]
			switch (kind) {
				case "rename":
					await f.history.renameTask("root", "Renamed")
					break
				case "stash":
					await f.history.toggleTaskStashed("root")
					break
				case "settle":
					await f.history.toggleTaskSettled("root")
					break
				case "tags":
					await f.history.setThreadTags("root", [{ name: "test", color: "blue" }] as never, [])
					break
				case "group":
					await f.history.setTaskGroup("root", "group")
					break
				case "save":
					await f.history.updateTaskHistoryItem({ ...item, task: "Saved" })
					break
				case "usage":
					await f.history.updateTaskHistoryItem({ ...item, tokensIn: 99 })
					break
				case "status":
					await f.history.saveThreadStatus("root", "error")
					break
				case "delete":
					await f.history.deleteTaskFromState("root")
					break
				case "deleteAll":
					await f.history.deleteAllTaskHistory()
					break
				case "new thread":
					f.create("new")
					break
				case "subagent spawn":
					f.create("child", { isSubagent: true, parentSessionId: "root" })
					break
				case "import":
					f.create("imported")
					break
				case "live subagent":
					f.controller.subagentThreads.set("child", { ...item, id: "child", isSubagent: true, parentTaskId: "root" })
					break
			}
			const second = await f.controller.getStateToPostToWebview()
			expect(second.taskHistory).not.toBe(first.taskHistory)
			if (kind === "delete" || kind === "deleteAll") expect(second.taskHistory).toHaveLength(0)
			else if (["new thread", "subagent spawn", "import", "live subagent"].includes(kind))
				expect(second.taskHistory).toHaveLength(2)
			else if (kind === "status") expect(second.sessionStatuses.root).toBe("error")
			else expect(second.taskHistory[0]).not.toEqual(item)
			const third = await f.controller.getStateToPostToWebview()
			expect(third.taskHistory).toBe(second.taskHistory)
		} finally {
			await f.close()
		}
	})
})
