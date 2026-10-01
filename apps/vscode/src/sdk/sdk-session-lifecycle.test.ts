import { beforeEach, describe, expect, it, vi } from "vitest"
import { isAbortError, SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { SdkTaskHistory } from "./sdk-task-history"

type StartInput = Parameters<SdkSessionLifecycle["startNewSession"]>[0]
type SendHost = Parameters<SdkSessionLifecycle["fireAndForgetSend"]>[0]

const mockCreateSessionHost = vi.hoisted(() => vi.fn())

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: () => undefined,
		}),
	},
}))

vi.mock("./vscode-session-host", () => ({
	VscodeSessionHost: {
		create: mockCreateSessionHost,
	},
}))

describe("SdkSessionLifecycle", () => {
	beforeEach(() => {
		mockCreateSessionHost.mockReset()
	})

	it.each(["single", "multi", "all", "except-favorites"])("fences resumes through %s persistence deletion", async (kind) => {
		const host = makeSdkHost()
		mockCreateSessionHost.mockResolvedValue(host)
		const lifecycle = makeLifecycle()
		const input = { config: { sessionId: "session-123" } } as StartInput
		await lifecycle.startNewSession(input)
		const { history, deletingPersistence, releasePersistence } = makeDeletionHistory(lifecycle)
		const deletion =
			kind === "single"
				? history.deleteTaskFromState("session-123")
				: kind === "multi"
					? history.deleteTasksFromState(["session-123", "other"])
					: history.deleteAllTaskHistory({ preserveFavorites: kind === "except-favorites" })
		await deletingPersistence.promise
		// The handle is gone but persistence still exists, matching the reviewer probe.
		expect(lifecycle.getSession("session-123")).toBeUndefined()
		await expect(lifecycle.startNewSession(input)).rejects.toThrow("Task is being deleted")
		expect(() => lifecycle.focusSession("session-123")).toThrow("Task is being deleted")
		expect(() => lifecycle.fireAndForgetSend(host as unknown as SendHost, "session-123", "resume")).toThrow(
			"Task is being deleted",
		)
		lifecycle.focusSession(undefined)
		releasePersistence.resolve()
		await deletion
		expect(lifecycle.getSession("session-123")).toBeUndefined()
		expect(() => lifecycle.assertTaskAvailable("session-123")).not.toThrow()
	})

	it.each(["single", "all"])("clears the %s deletion fence on persistence failure and permits a retry", async (kind) => {
		const host = makeSdkHost()
		mockCreateSessionHost.mockResolvedValue(host)
		const lifecycle = makeLifecycle()
		const input = { config: { sessionId: "session-123" } } as StartInput
		await lifecycle.startNewSession(input)
		const { history, deletingPersistence, releasePersistence } = makeDeletionHistory(lifecycle, new Error("disk failed"))
		const deletion =
			kind === "single"
				? expect(history.deleteTaskFromState("session-123")).rejects.toThrow("disk failed")
				: expect(history.deleteAllTaskHistory()).resolves.toBe(0)
		await deletingPersistence.promise
		await expect(lifecycle.startNewSession(input)).rejects.toThrow("Task is being deleted")
		releasePersistence.resolve()
		await deletion
		await expect(lifecycle.startNewSession(input)).resolves.toMatchObject({ startResult: { sessionId: "session-123" } })
	})

	it("waits for an already-starting resume before deleting persistence", async () => {
		const enteredStart = Promise.withResolvers<void>()
		const finishStart = Promise.withResolvers<{ sessionId: string }>()
		const host = makeSdkHost({
			start: vi.fn(() => {
				enteredStart.resolve()
				return finishStart.promise
			}),
		})
		mockCreateSessionHost.mockResolvedValue(host)
		const lifecycle = makeLifecycle()
		const starting = expect(
			lifecycle.startNewSession({ config: { sessionId: "session-123" } } as StartInput),
		).rejects.toThrow("Task is being deleted")
		await enteredStart.promise
		const { history, deletingPersistence, releasePersistence, deleteRecord } = makeDeletionHistory(lifecycle)
		const deletion = history.deleteTaskFromState("session-123")
		await Promise.resolve()
		expect(deleteRecord).not.toHaveBeenCalled()
		finishStart.resolve({ sessionId: "session-123" })
		await starting
		await deletingPersistence.promise
		expect(host.stop).toHaveBeenCalledWith("session-123")
		expect(lifecycle.getSession("session-123")).toBeUndefined()
		releasePersistence.resolve()
		await deletion
	})

	it("fences delete-all before its initial history enumeration finishes", async () => {
		const lifecycle = makeLifecycle()
		const { history, releasePersistence } = makeDeletionHistory(lifecycle)
		const listing = Promise.withResolvers<void>()
		const listed = Promise.withResolvers<Awaited<ReturnType<SdkTaskHistory["listHistory"]>>>()
		vi.mocked(history.listHistory).mockImplementationOnce(() => {
			listing.resolve()
			return listed.promise
		})
		const deletion = history.deleteAllTaskHistory()
		await listing.promise
		await expect(lifecycle.startNewSession({ config: { sessionId: "session-123" } } as StartInput)).rejects.toThrow(
			"Task is being deleted",
		)
		listed.resolve([{ sessionId: "session-123", metadata: {} } as never])
		releasePersistence.resolve()
		await deletion
		expect(() => lifecycle.assertTaskAvailable("session-123")).not.toThrow()
	})

	it("clears the fence after a failed stop and keeps the live task resumable", async () => {
		const host = makeSdkHost({ stop: vi.fn().mockRejectedValueOnce(new Error("stop failed")) })
		mockCreateSessionHost.mockResolvedValue(host)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({ config: { sessionId: "session-123" } } as StartInput)
		const { history, deleteRecord } = makeDeletionHistory(lifecycle)
		await expect(history.deleteTaskFromState("session-123")).rejects.toThrow("stop failed")
		expect(deleteRecord).not.toHaveBeenCalled()
		expect(lifecycle.getSession("session-123")).toBeDefined()
		expect(() => lifecycle.focusSession("session-123")).not.toThrow()
	})

	it("removes a running background task and fences its pending send completion", async () => {
		let finish!: () => void
		const host = makeSdkHost({
			start: vi.fn().mockResolvedValueOnce({ sessionId: "background" }).mockResolvedValueOnce({ sessionId: "focus" }),
			send: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve
					}),
			),
		})
		mockCreateSessionHost.mockResolvedValueOnce(host)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({} as StartInput)
		lifecycle.fireAndForgetSend(host as unknown as SendHost, "background", "work")
		lifecycle.focusSession("focus")
		await lifecycle.startNewSession({} as StartInput)
		lifecycle.setSubagentCounts("background", { total: 2, live: 1 })
		await lifecycle.removeSession("background")
		finish()
		await Promise.resolve()
		expect(host.stop).toHaveBeenCalledWith("background")
		expect(lifecycle.getSession("background")).toBeUndefined()
		expect(lifecycle.sessionStatuses.background).toBeUndefined()
		expect(lifecycle.subagentCounts.background).toBeUndefined()
		expect(lifecycle.getActiveSession()?.sessionId).toBe("focus")
	})

	it("keeps a failed stop retryable without clearing task status", async () => {
		const host = makeSdkHost()
		mockCreateSessionHost.mockResolvedValueOnce(host)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({} as StartInput)
		const id = lifecycle.getActiveSession()!.sessionId
		host.stop.mockRejectedValueOnce(new Error("stop failed"))
		await expect(lifecycle.removeSession(id)).rejects.toThrow("stop failed")
		expect(lifecycle.getSession(id)).toBeDefined()
		await lifecycle.removeSession(id)
		expect(lifecycle.getSession(id)).toBeUndefined()
	})

	it.each([
		"focus",
		"running",
		"queue",
		"waiting",
		"replacement",
	])("rechecks %s during an awaited idle stop", async (change) => {
		let id = 0
		let release!: () => void
		const host = makeSdkHost({ start: vi.fn(async () => ({ sessionId: String(++id) })) })
		mockCreateSessionHost.mockResolvedValueOnce(host)
		const lifecycle = makeLifecycle()
		for (let index = 0; index < 11; index++) {
			lifecycle.focusSession(String(index + 1))
			await lifecycle.startNewSession({} as StartInput)
		}
		for (const session of lifecycle.getSessions().values()) session.isRunning = false
		host.stop.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const pruning = (lifecycle as unknown as { pruneIdleSessions(): Promise<void> }).pruneIdleSessions()
		await vi.waitFor(() => expect(host.stop).toHaveBeenCalledWith("1"))
		const candidate = lifecycle.getSession("2")!
		if (change === "focus") lifecycle.focusSession("2")
		if (change === "running") candidate.isRunning = true
		if (change === "queue") candidate.queuedPromptCount = 1
		if (change === "waiting") lifecycle.setStatus("2", "waiting")
		if (change === "replacement") {
			;(lifecycle.getSessions() as Map<string, typeof candidate>).set("2", { ...candidate, isRunning: true })
		}
		const overlapping = (lifecycle as unknown as { pruneIdleSessions(): Promise<void> }).pruneIdleSessions()
		expect(overlapping).toBe(pruning)
		release()
		await pruning
		expect(host.stop).not.toHaveBeenCalledWith("2")
		expect(lifecycle.getSession("2")).toBeDefined()
	})

	it("replaces an idle background provider without changing focus", async () => {
		const host = makeSdkHost({
			start: vi
				.fn()
				.mockResolvedValueOnce({ sessionId: "a" })
				.mockResolvedValueOnce({ sessionId: "b" })
				.mockResolvedValueOnce({ sessionId: "a" }),
		})
		mockCreateSessionHost.mockResolvedValueOnce(host)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({ mode: "plan" } as StartInput)
		lifecycle.setRunning(false, "a")
		lifecycle.focusSession("b")
		await lifecycle.startNewSession({ mode: "act" } as StartInput)
		const a = lifecycle.getSession("a")!
		await lifecycle.replaceSession({
			expectedSession: a,
			startInput: {
				mode: "plan",
				config: {
					providerId: "openai-compatible",
					modelId: "new-model",
					sessionId: "a",
				},
			} as StartInput,
			disposeReason: "providerChange",
		})
		expect(host.stop).toHaveBeenCalledWith("a")
		expect(lifecycle.getActiveSession()?.sessionId).toBe("b")
		expect(lifecycle.getSession("a")?.startConfig).toMatchObject({ modelId: "new-model", mode: "plan" })
		expect(lifecycle.getSession("a")?.isRunning).toBe(false)
	})

	it("starts a session in the background without moving the focused task", async () => {
		const host = makeSdkHost({
			start: vi.fn().mockResolvedValueOnce({ sessionId: "focused" }).mockResolvedValueOnce({ sessionId: "bg" }),
		})
		mockCreateSessionHost.mockResolvedValueOnce(host)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({ config: { sessionId: "focused" } } as StartInput)
		expect(lifecycle.getActiveSession()?.sessionId).toBe("focused")

		await lifecycle.startNewSession({ config: { sessionId: "bg" } } as StartInput, { focus: false })

		expect(lifecycle.getSession("bg")).toBeDefined()
		expect(lifecycle.sessionStatuses.bg).toBe("running")
		expect(lifecycle.getActiveSession()?.sessionId).toBe("focused")
	})

	it("leaves nothing focused when a background session starts from the inbox", async () => {
		const host = makeSdkHost()
		mockCreateSessionHost.mockResolvedValueOnce(host)
		const lifecycle = makeLifecycle()

		await lifecycle.startNewSession({} as StartInput, { focus: false })

		expect(lifecycle.getSession("session-123")).toBeDefined()
		expect(lifecycle.sessionStatuses["session-123"]).toBe("running")
		expect(lifecycle.getActiveSession()).toBeUndefined()
	})

	it("starts a session and stores active session state", async () => {
		const unsubscribe = vi.fn()
		const sdkHost = makeSdkHost({ startResult: { sessionId: "session-123" }, unsubscribe })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		const result = await lifecycle.startNewSession({} as any)

		expect(result.startResult.sessionId).toBe("session-123")
		expect(result.sdkHost).toBe(sdkHost)
		expect(sdkHost.subscribe).toHaveBeenCalled()
		expect(lifecycle.getActiveSession()?.sessionId).toBe("session-123")
		expect(lifecycle.getActiveSession()?.isRunning).toBe(true)
	})

	it("records background completion and errors without changing focused running state", async () => {
		const start = vi.fn().mockResolvedValueOnce({ sessionId: "a" }).mockResolvedValueOnce({ sessionId: "b" })
		let finishA: () => void = () => {}
		const sdkHost = makeSdkHost({
			start,
			send: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishA = resolve
					}),
			),
		})
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({} as StartInput)
		lifecycle.fireAndForgetSend(sdkHost as unknown as SendHost, "a", "work")
		lifecycle.focusSession("b")
		await lifecycle.startNewSession({} as StartInput)
		finishA()
		await vi.waitFor(() => expect(lifecycle.sessionStatuses.a).toBe("done"))
		expect(lifecycle.getActiveSession()?.sessionId).toBe("b")
		expect(lifecycle.getSession("b")?.isRunning).toBe(true)
		lifecycle.setStatus("b", "waiting")
		expect(lifecycle.sessionStatuses.b).toBe("waiting")
		expect(sdkHost.stop).not.toHaveBeenCalled()
		await lifecycle.dispose()
		expect(sdkHost.stop).toHaveBeenCalledWith("a")
		expect(sdkHost.stop).toHaveBeenCalledWith("b")
	})

	it("caps idle handles while retaining running and waiting sessions", async () => {
		let id = 0
		const sdkHost = makeSdkHost({ start: vi.fn(async () => ({ sessionId: String(++id) })) })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		for (let index = 0; index < 12; index++) {
			lifecycle.focusSession(String(index + 1))
			await lifecycle.startNewSession({} as StartInput)
			lifecycle.setRunning(false)
		}
		expect(lifecycle.getSessions().size).toBeLessThanOrEqual(9)
		expect(lifecycle.getSession("12")).toBeDefined()
		expect(lifecycle.sessionStatuses["1"]).toBe("done")
	})

	it("stores the provider and model config used to start the active session", async () => {
		const sdkHost = makeSdkHost({ startResult: { sessionId: "session-123" } })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()

		await lifecycle.startNewSession({
			config: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4",
			},
		} as StartInput)

		expect(lifecycle.getActiveSession()?.startConfig).toEqual(
			expect.objectContaining({
				providerId: "anthropic",
				modelId: "claude-sonnet-4",
			}),
		)
	})

	it("reuses the shared session host across sessions", async () => {
		const sdkHost = makeSdkHost({
			start: vi.fn().mockResolvedValueOnce({ sessionId: "session-1" }).mockResolvedValueOnce({ sessionId: "session-2" }),
		})
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)
		await lifecycle.endActiveSession("test")
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		expect(mockCreateSessionHost).toHaveBeenCalledOnce()
		expect(sdkHost.subscribe).toHaveBeenCalledOnce()
		expect(sdkHost.start).toHaveBeenCalledTimes(2)
		expect(sdkHost.stop).toHaveBeenCalledWith("session-1")
		expect(sdkHost.dispose).not.toHaveBeenCalled()
		expect(lifecycle.getActiveSession()?.sessionId).toBe("session-2")
	})

	it("keeps multiple sessions alive and switches focus without stopping them", async () => {
		const unsubscribe = vi.fn()
		const sdkHost = makeSdkHost({
			start: vi.fn().mockResolvedValueOnce({ sessionId: "session-1" }).mockResolvedValueOnce({ sessionId: "session-2" }),
			unsubscribe,
		})
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		expect(mockCreateSessionHost).toHaveBeenCalledOnce()
		expect(sdkHost.subscribe).toHaveBeenCalledOnce()
		expect(sdkHost.stop).not.toHaveBeenCalled()
		expect(lifecycle.getSessions().size).toBe(2)
		lifecycle.focusSession("session-2")
		expect(unsubscribe).not.toHaveBeenCalled()
		expect(lifecycle.getActiveSession()?.sessionId).toBe("session-2")

		await lifecycle.dispose("testDispose")
		expect(unsubscribe).toHaveBeenCalledOnce()
	})

	it("unsubscribes if session start fails", async () => {
		const unsubscribe = vi.fn()
		const error = new Error("start failed")
		const sdkHost = makeSdkHost({ start: vi.fn().mockRejectedValue(error), unsubscribe })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await expect(lifecycle.startNewSession({} as any)).rejects.toBe(error)

		expect(unsubscribe).not.toHaveBeenCalled()
		expect(lifecycle.getActiveSession()).toBeUndefined()

		await lifecycle.dispose("testDispose")
		expect(unsubscribe).toHaveBeenCalledOnce()
	})

	it("disposes the shared host only when the lifecycle is disposed", async () => {
		const unsubscribe = vi.fn()
		const sdkHost = makeSdkHost({ startResult: { sessionId: "session-123" }, unsubscribe })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		await lifecycle.dispose("testDispose")

		expect(unsubscribe).toHaveBeenCalledOnce()
		expect(sdkHost.stop).toHaveBeenCalledWith("session-123")
		expect(sdkHost.dispose).toHaveBeenCalledWith("testDispose")
		expect(lifecycle.getActiveSession()).toBeUndefined()
	})

	it("passes the policy readiness gate to the shared session host", async () => {
		const beforeStartSession = vi.fn().mockResolvedValue(undefined)
		const sdkHost = makeSdkHost({ startResult: { sessionId: "session-123" } })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ beforeStartSession })

		await lifecycle.startNewSession({} as StartInput)

		expect(mockCreateSessionHost).toHaveBeenCalledWith(expect.objectContaining({ beforeStartSession }))
	})

	it("passes shared telemetry to the VSCode session host", async () => {
		const telemetry = { capture: vi.fn() }
		const sdkHost = makeSdkHost({ startResult: { sessionId: "session-123" } })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		const lifecycle = makeLifecycle({ telemetry: telemetry as any })

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		expect(mockCreateSessionHost).toHaveBeenCalledWith(expect.objectContaining({ telemetry }))
	})

	it("marks the active session idle after a non-queued send completes", async () => {
		const onSendComplete = vi.fn()
		const sdkHost = makeSdkHost({ send: vi.fn().mockResolvedValue(undefined) })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onSendComplete })
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "hello")
		await vi.waitFor(() => expect(onSendComplete).toHaveBeenCalledWith("session-123"))

		expect(lifecycle.getActiveSession()?.isRunning).toBe(false)
	})

	it("keeps the session running when a send settles after Core started the next queued turn", async () => {
		const onDidBecomeIdle = vi.fn()
		let resolveSend: () => void = () => {}
		const sdkHost = makeSdkHost({
			send: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveSend = resolve
					}),
			),
		})
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onDidBecomeIdle })
		await lifecycle.startNewSession({} as StartInput)

		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "first")
		// Core emits idle for the first turn and immediately drains a queued prompt.
		lifecycle.setRunning(false)
		lifecycle.setRunning(true)
		resolveSend()
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(lifecycle.getActiveSession()?.isRunning).toBe(true)
		expect(onDidBecomeIdle).toHaveBeenCalledOnce()
	})

	it("treats an emptied prompt queue on an idle session as becoming idle", async () => {
		const onDidBecomeIdle = vi.fn()
		const sdkHost = makeSdkHost()
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onDidBecomeIdle })
		await lifecycle.startNewSession({} as StartInput)

		lifecycle.setQueuedPromptCount(2)
		lifecycle.setRunning(false)
		expect(onDidBecomeIdle).toHaveBeenCalledTimes(1)
		expect(lifecycle.getActiveSession()?.queuedPromptCount).toBe(2)

		lifecycle.setQueuedPromptCount(0)
		expect(onDidBecomeIdle).toHaveBeenCalledTimes(2)
	})

	it("notifies idle listeners after a send fails", async () => {
		const onDidBecomeIdle = vi.fn()
		const onSendError = vi.fn()
		const sdkHost = makeSdkHost({ send: vi.fn().mockRejectedValue(new Error("provider failed")) })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onDidBecomeIdle, onSendError })
		await lifecycle.startNewSession({} as StartInput)

		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "hello")
		await vi.waitFor(() => expect(onSendError).toHaveBeenCalledWith(expect.any(Error), "session-123"))

		expect(onDidBecomeIdle).toHaveBeenCalledOnce()
		expect(lifecycle.getActiveSession()?.isRunning).toBe(false)
	})

	it("notifies idle listeners only on a running-to-idle transition", async () => {
		const onDidBecomeIdle = vi.fn()
		const sdkHost = makeSdkHost()
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onDidBecomeIdle })
		await lifecycle.startNewSession({} as StartInput)

		lifecycle.setRunning(false)
		lifecycle.setRunning(false)

		expect(onDidBecomeIdle).toHaveBeenCalledOnce()
	})

	it("calls the send-start hook before sending to the SDK host", async () => {
		const onSendStart = vi.fn()
		const send = vi.fn().mockResolvedValue(undefined)
		const sdkHost = makeSdkHost({ send })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onSendStart })
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "hello")
		await vi.waitFor(() => expect(send).toHaveBeenCalled())

		expect(onSendStart).toHaveBeenCalledWith("session-123", undefined)
		expect(onSendStart.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
	})

	it("leaves the active session running when a message is queued", async () => {
		const onSendComplete = vi.fn()
		const send = vi.fn().mockResolvedValue(undefined)
		const sdkHost = makeSdkHost({ send })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onSendComplete })
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "hello", undefined, undefined, "queue")
		await vi.waitFor(() => expect(send).toHaveBeenCalled())

		expect(onSendComplete).not.toHaveBeenCalled()
		expect(lifecycle.getActiveSession()?.isRunning).toBe(true)
	})

	it("marks the active session idle and reports non-abort send errors", async () => {
		const onSendError = vi.fn()
		const error = new Error("boom")
		const sdkHost = makeSdkHost({ send: vi.fn().mockRejectedValue(error) })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onSendError })
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "hello")
		await vi.waitFor(() => expect(onSendError).toHaveBeenCalledWith(error, "session-123"))

		expect(lifecycle.getActiveSession()?.isRunning).toBe(false)
	})

	it("skips completion bookkeeping when the session was replaced before the send settled", async () => {
		const onSendComplete = vi.fn()
		let resolveSend: () => void = () => {}
		const send = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveSend = resolve
				}),
		)
		const sdkHost = makeSdkHost({
			start: vi
				.fn()
				.mockResolvedValueOnce({ sessionId: "plan-session" })
				.mockResolvedValueOnce({ sessionId: "plan-session" }),
			send,
		})
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onSendComplete })
		await lifecycle.startNewSession({} as StartInput)
		const expectedSession = lifecycle.getActiveSession()!

		lifecycle.fireAndForgetSend(sdkHost as unknown as SendHost, "plan-session", "make a plan")
		lifecycle.setRunning(false)

		// A mode-change rebuild replaces the session, reusing the SAME sessionId,
		// and starts an auto-continued turn on it.
		await lifecycle.replaceActiveSession({
			expectedSession,
			startInput: { config: {} } as unknown as StartInput,
			disposeReason: "modeChange",
		})
		lifecycle.setRunning(true)

		// The old send settles only now; its bookkeeping must not touch the successor.
		resolveSend()
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(onSendComplete).not.toHaveBeenCalled()
		expect(lifecycle.getActiveSession()?.isRunning).toBe(true)
	})

	it("skips error bookkeeping when the session was replaced before the send failed", async () => {
		const onSendError = vi.fn()
		let rejectSend: (error: Error) => void = () => {}
		const send = vi.fn(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectSend = reject
				}),
		)
		const sdkHost = makeSdkHost({
			start: vi
				.fn()
				.mockResolvedValueOnce({ sessionId: "plan-session" })
				.mockResolvedValueOnce({ sessionId: "plan-session" }),
			send,
		})
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ onSendError })
		await lifecycle.startNewSession({} as StartInput)
		const expectedSession = lifecycle.getActiveSession()!

		lifecycle.fireAndForgetSend(sdkHost as unknown as SendHost, "plan-session", "make a plan")
		lifecycle.setRunning(false)

		await lifecycle.replaceActiveSession({
			expectedSession,
			startInput: { config: {} } as unknown as StartInput,
			disposeReason: "modeChange",
		})
		lifecycle.setRunning(true)

		rejectSend(new Error("boom"))
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(onSendError).not.toHaveBeenCalled()
		expect(lifecycle.getActiveSession()?.isRunning).toBe(true)
	})

	it("completes the old session stop before starting a same-id replacement", async () => {
		let resolveStop: () => void = () => {}
		const stop = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveStop = resolve
				}),
		)
		const start = vi
			.fn()
			.mockResolvedValueOnce({ sessionId: "plan-session" })
			.mockResolvedValueOnce({ sessionId: "plan-session" })
		const sdkHost = makeSdkHost({ start, stop })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({} as StartInput)
		lifecycle.setRunning(false)
		const expectedSession = lifecycle.getActiveSession()!

		const replacePromise = lifecycle.replaceActiveSession({
			expectedSession,
			startInput: { config: { sessionId: "plan-session" } } as unknown as StartInput,
			disposeReason: "modeChange",
		})
		await new Promise((resolve) => setTimeout(resolve, 0))

		// Core cleanup deletes by sessionId, so the same-id replacement must not
		// start while the old stop is still in flight.
		expect(start).toHaveBeenCalledTimes(1)

		resolveStop()
		const result = await replacePromise

		expect(start).toHaveBeenCalledTimes(2)
		expect(result?.startResult.sessionId).toBe("plan-session")
	})

	it("passes compacted initial messages after a same-id replacement stop completes", async () => {
		let resolveStop: () => void = () => {}
		const stop = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveStop = resolve
				}),
		)
		const start = vi
			.fn()
			.mockResolvedValueOnce({ sessionId: "task-session" })
			.mockResolvedValueOnce({ sessionId: "task-session" })
		const sdkHost = makeSdkHost({ start, stop })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({ config: { sessionId: "task-session" } } as unknown as StartInput)
		lifecycle.setRunning(false)
		const expectedSession = lifecycle.getActiveSession()!

		const initialMessages = [{ role: "user", content: "compacted summary" }]
		const replacePromise = lifecycle.replaceActiveSession({
			expectedSession,
			startInput: {
				config: { sessionId: "task-session" },
				prompt: undefined,
				interactive: true,
			} as unknown as StartInput,
			initialMessages: initialMessages as unknown as StartInput["initialMessages"],
			disposeReason: "compactTask",
		})
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(start).toHaveBeenCalledTimes(1)

		resolveStop()
		const result = await replacePromise

		expect(result?.startResult.sessionId).toBe("task-session")
		expect(start).toHaveBeenLastCalledWith({
			config: { sessionId: "task-session" },
			prompt: undefined,
			interactive: true,
			initialMessages,
		})
		expect(lifecycle.getActiveSession()?.isRunning).toBe(false)
	})

	it("waits for a fire-and-forget stop before resuming the same sessionId", async () => {
		let resolveStop: () => void = () => {}
		const stop = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveStop = resolve
				}),
		)
		const start = vi.fn().mockResolvedValueOnce({ sessionId: "task-1" }).mockResolvedValueOnce({ sessionId: "task-1" })
		const sdkHost = makeSdkHost({ start, stop })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({} as StartInput)

		// The follow-up resume path ends the idle session without awaiting the
		// stop, then starts a new session reusing the taskId as the sessionId.
		await lifecycle.endActiveSession("askResponse")
		const resumePromise = lifecycle.startNewSession({ config: { sessionId: "task-1" } } as unknown as StartInput)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(start).toHaveBeenCalledTimes(1)

		resolveStop()
		const result = await resumePromise

		expect(start).toHaveBeenCalledTimes(2)
		expect(result.startResult.sessionId).toBe("task-1")
	})

	it("starts a fresh-id session without waiting for an unrelated hung stop", async () => {
		const stop = vi.fn(() => new Promise<void>(() => {}))
		const start = vi.fn().mockResolvedValueOnce({ sessionId: "task-1" }).mockResolvedValueOnce({ sessionId: "task-2" })
		const sdkHost = makeSdkHost({ start, stop })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({} as StartInput)

		// A brand-new task does not reuse the old sessionId, so it must not be
		// delayed by the old session's stop.
		const result = await lifecycle.startNewSession({ config: {} } as unknown as StartInput)

		expect(result.startResult.sessionId).toBe("task-2")
		expect(stop).not.toHaveBeenCalled()
	})

	it("replaces the active session by stopping the old session and reusing the shared host", async () => {
		const oldUnsubscribe = vi.fn()
		const sdkHost = makeSdkHost({
			start: vi
				.fn()
				.mockResolvedValueOnce({ sessionId: "old-session" })
				.mockResolvedValueOnce({ sessionId: "new-session" }),
			unsubscribe: oldUnsubscribe,
			stop: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		})
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)
		lifecycle.setRunning(false)
		const expectedSession = lifecycle.getActiveSession()!

		const result = await lifecycle.replaceActiveSession({
			expectedSession,
			// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
			startInput: { config: {} } as any,
			// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
			initialMessages: [{ role: "user", content: "hello" }] as any,
			disposeReason: "testReplace",
		})

		expect(result?.oldSessionId).toBe("old-session")
		expect(result?.startResult.sessionId).toBe("new-session")
		expect(oldUnsubscribe).not.toHaveBeenCalled()
		expect(sdkHost.stop).toHaveBeenCalledWith("old-session")
		expect(sdkHost.dispose).not.toHaveBeenCalled()
		expect(mockCreateSessionHost).toHaveBeenCalledOnce()
		expect(sdkHost.subscribe).toHaveBeenCalledOnce()
		expect(sdkHost.start).toHaveBeenLastCalledWith({
			config: {},
			initialMessages: [{ role: "user", content: "hello" }],
		})
		expect(lifecycle.getActiveSession()?.sessionId).toBe("new-session")
		expect(lifecycle.getActiveSession()?.isRunning).toBe(false)
	})

	it("does not replace a session that started running", async () => {
		const sdkHost = makeSdkHost()
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		await lifecycle.startNewSession({} as StartInput)
		const expectedSession = lifecycle.getActiveSession()!

		const result = await lifecycle.replaceActiveSession({
			expectedSession,
			startInput: {} as StartInput,
			disposeReason: "test",
		})

		expect(result).toBeUndefined()
		expect(sdkHost.stop).not.toHaveBeenCalled()
	})

	it("adopts the restored session and stops the source session", async () => {
		const restored = {
			sessionId: "restored-session",
			startResult: { sessionId: "restored-session" },
			checkpoint: { ref: "abc", createdAt: 1, runCount: 1 },
		}
		const sdkHost = makeSdkHost({
			startResult: { sessionId: "source-session" },
			restore: vi.fn().mockResolvedValue(restored),
		})
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()

		await lifecycle.startNewSession({
			config: {
				sessionId: "source-session",
				providerId: "openai",
				modelId: "gpt-5",
			},
		} as StartInput)
		const result = await lifecycle.restoreActiveSession({
			sessionId: "source-session",
			checkpointRunCount: 1,
		})

		expect(result).toBe(restored)
		expect(lifecycle.getActiveSession()?.sessionId).toBe("restored-session")
		expect(lifecycle.getActiveSession()?.startConfig).toEqual(
			expect.objectContaining({
				providerId: "openai",
				modelId: "gpt-5",
			}),
		)
		expect(sdkHost.stop).toHaveBeenCalledWith("source-session")
	})

	it("updates the active session model for the next turn when supported", async () => {
		const updateSessionModel = vi.fn().mockResolvedValue(undefined)
		const sdkHost = makeSdkHost({ startResult: { sessionId: "session-123" }, updateSessionModel })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		const didUpdate = await lifecycle.updateActiveSessionModel("deepseek-v4-flash")

		expect(didUpdate).toBe(true)
		expect(updateSessionModel).toHaveBeenCalledWith("session-123", "deepseek-v4-flash")
	})

	it("does not update active session model when no host capability is available", async () => {
		const sdkHost = makeSdkHost({ startResult: { sessionId: "session-123" } })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle()
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		const didUpdate = await lifecycle.updateActiveSessionModel("deepseek-v4-flash")

		expect(didUpdate).toBe(false)
	})

	it("detects abort errors", () => {
		const error = new Error("aborted by user")
		expect(isAbortError(error)).toBe(true)
	})

	it("stamps a pending mode-switch notice onto the outbound prompt", async () => {
		const send = vi.fn().mockResolvedValue(undefined)
		const sdkHost = makeSdkHost({ send })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		// Real tracker semantics live in @cline/shared and SdkModeCoordinator;
		// here a one-shot stub proves the consume-once wiring: first send is
		// stamped, later sends go out untouched.
		let pending: { from: "act"; to: "plan" } | null = { from: "act", to: "plan" }
		const consumeModeSwitchNotice = vi.fn((sessionId: string) => {
			if (sessionId !== "session-123") {
				return null
			}
			const notice = pending
			pending = null
			return notice
		})
		const lifecycle = makeLifecycle({ consumeModeSwitchNotice })
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "how should we refactor this?")
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-123",
				prompt: "<mode_notice>The user switched from Act mode to Ask mode before sending this message.</mode_notice>\nhow should we refactor this?",
			}),
		)

		// The notice was consumed by the first send; the next message is clean.
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "and the tests?")
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
		expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "and the tests?" }))
	})

	it("sends prompts unchanged when no mode-switch notice is pending", async () => {
		const send = vi.fn().mockResolvedValue(undefined)
		const sdkHost = makeSdkHost({ send })
		mockCreateSessionHost.mockResolvedValueOnce(sdkHost)
		const lifecycle = makeLifecycle({ consumeModeSwitchNotice: vi.fn(() => null) })
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		await lifecycle.startNewSession({} as any)

		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		lifecycle.fireAndForgetSend(sdkHost as any, "session-123", "hello")
		await vi.waitFor(() => expect(send).toHaveBeenCalled())

		expect(send).toHaveBeenCalledWith(expect.objectContaining({ prompt: "hello" }))
	})
})

function makeLifecycle(overrides: Partial<ConstructorParameters<typeof SdkSessionLifecycle>[0]> = {}) {
	return new SdkSessionLifecycle({
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for lifecycle unit test
		mcpHub: {} as any,
		requestToolApproval: vi.fn(),
		askQuestion: vi.fn(),
		onSessionEvent: vi.fn(),
		onSendComplete: vi.fn(),
		onSendError: vi.fn(),
		...overrides,
	})
}

function makeSdkHost(overrides: Record<string, unknown> = {}) {
	const startResult = overrides.startResult ?? { sessionId: "session-123" }
	return {
		start: vi.fn().mockResolvedValue(startResult),
		subscribe: vi.fn().mockReturnValue(overrides.unsubscribe ?? vi.fn()),
		send: vi.fn().mockResolvedValue(undefined),
		restore: vi.fn().mockResolvedValue({
			sessionId: "session-123",
			startResult,
			checkpoint: { ref: "abc", createdAt: 1, runCount: 1 },
		}),
		stop: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}
}

function makeDeletionHistory(lifecycle: SdkSessionLifecycle, failure?: Error) {
	const history = new SdkTaskHistory({ sessions: lifecycle, mcpHub: {} as never })
	const deletingPersistence = Promise.withResolvers<void>()
	const releasePersistence = Promise.withResolvers<void>()
	const deleteRecord = vi.fn(async () => {
		deletingPersistence.resolve()
		await releasePersistence.promise
		if (failure) throw failure
	})
	const internals = history as unknown as {
		withHistoryHost: (fn: (host: { delete: typeof deleteRecord }) => Promise<unknown>) => Promise<unknown>
		findLegacyTask: () => undefined
	}
	vi.spyOn(internals, "withHistoryHost").mockImplementation(async (fn) => fn({ delete: deleteRecord }))
	vi.spyOn(internals, "findLegacyTask").mockReturnValue(undefined)
	vi.spyOn(history, "listHistory").mockResolvedValue([{ sessionId: "session-123", metadata: {} } as never])
	return { history, deletingPersistence, releasePersistence, deleteRecord }
}
