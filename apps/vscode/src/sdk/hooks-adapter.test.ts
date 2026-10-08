// Hook-execution telemetry only fires when the adapter passes a task id into
// HookFactory.create (StdioHookRunner gates every captureHookExecution on it),
// so these tests pin the id threading at every adapter call site.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildAgentHooks, type HookMessageEmitter, resetHookFiringStateForTests } from "./hooks-adapter"

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
}))

vi.mock("@/core/hooks/hook-factory", () => ({
	HookFactory: class {
		create = mocks.create
	},
}))

function makeRunner() {
	return {
		isNoOp: false,
		run: vi.fn(async () => ({ cancel: false, contextModification: "", errorMessage: "" })),
	}
}

const snapshot = {
	conversationId: "conv-1",
	runId: "run-1",
	agentId: "agent-1",
	messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
} as never

const stateManager = { getGlobalSettingsKey: vi.fn(() => true) } as never

describe("hooks-adapter task id threading", () => {
	let runner: ReturnType<typeof makeRunner>

	beforeEach(() => {
		mocks.create.mockReset()
		runner = makeRunner()
		mocks.create.mockResolvedValue(runner)
	})

	it("passes the task id and tool name when creating the PreToolUse runner", async () => {
		const hooks = buildAgentHooks(stateManager)
		await hooks.beforeTool?.({ toolCall: { toolName: "read_file" }, input: { path: "a.ts" }, snapshot } as never)

		expect(mocks.create).toHaveBeenCalledWith("PreToolUse", "conv-1", "read_file")
		expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ taskId: "conv-1" }))
	})

	it("passes the task id and tool name when creating the PostToolUse runner", async () => {
		const hooks = buildAgentHooks(stateManager)
		await hooks.afterTool?.({
			toolCall: { toolName: "write_file" },
			input: {},
			result: { output: "ok", isError: false },
			durationMs: 5,
			snapshot,
		} as never)

		expect(mocks.create).toHaveBeenCalledWith("PostToolUse", "conv-1", "write_file")
		expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ taskId: "conv-1" }))
	})

	it("passes the task id when creating the TaskStart and UserPromptSubmit runners", async () => {
		const hooks = buildAgentHooks(stateManager)
		await hooks.beforeRun?.({ snapshot } as never)

		expect(mocks.create).toHaveBeenCalledWith("TaskStart", "conv-1")
		expect(mocks.create).toHaveBeenCalledWith("UserPromptSubmit", "conv-1")
	})

	it("passes the task id when creating the TaskComplete runner", async () => {
		const hooks = buildAgentHooks(stateManager)
		await hooks.afterRun?.({ snapshot, result: { status: "completed", outputText: "done" } } as never)

		expect(mocks.create).toHaveBeenCalledWith("TaskComplete", "conv-1")
	})

	it("passes the task id when creating the TaskCancel runner", async () => {
		const hooks = buildAgentHooks(stateManager)
		await hooks.afterRun?.({ snapshot, result: { status: "aborted", outputText: "" } } as never)

		expect(mocks.create).toHaveBeenCalledWith("TaskCancel", "conv-1")
	})

	it("falls back to the run id when the snapshot has no conversation id", async () => {
		const hooks = buildAgentHooks(stateManager)
		await hooks.beforeTool?.({
			toolCall: { toolName: "read_file" },
			input: {},
			snapshot: { ...(snapshot as object), conversationId: undefined },
		} as never)

		expect(mocks.create).toHaveBeenCalledWith("PreToolUse", "run-1", "read_file")
	})
})

// ---------------------------------------------------------------------------
// beforeRun lifecycle gating
// ---------------------------------------------------------------------------

const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const assistantMsg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
const toolResultMsg = () => ({
	role: "user",
	content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: "ok" }],
})

function snapshotWith(messages: unknown[], conversationId = "conv-1") {
	return { conversationId, runId: "run-1", agentId: "agent-1", messages } as never
}

function createdHookNames(): string[] {
	return mocks.create.mock.calls.map((call) => call[0] as string)
}

describe("hooks-adapter beforeRun gating", () => {
	let runner: ReturnType<typeof makeRunner>
	let emitMock: ReturnType<typeof vi.fn<HookMessageEmitter>>
	const emit: HookMessageEmitter = (message) => emitMock(message)

	beforeEach(() => {
		resetHookFiringStateForTests()
		mocks.create.mockReset()
		runner = makeRunner()
		mocks.create.mockResolvedValue(runner)
		emitMock = vi.fn<HookMessageEmitter>()
	})

	it("fires TaskStart only on the task's first run, across turns", async () => {
		const hooks = buildAgentHooks(stateManager, emit)

		await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("hi")]) } as never)
		expect(createdHookNames()).toEqual(["TaskStart", "UserPromptSubmit"])

		mocks.create.mockClear()
		// Turn 2: transcript now has an assistant reply.
		await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("hi"), assistantMsg("ok"), userMsg("next")]) } as never)
		expect(createdHookNames()).toEqual(["UserPromptSubmit"])
	})

	it("does not fire TaskStart when reopening a task with history", async () => {
		const hooks = buildAgentHooks(stateManager, emit)

		await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("old"), assistantMsg("done"), userMsg("again")]) } as never)
		expect(createdHookNames()).toEqual(["UserPromptSubmit"])
	})

	it("fires TaskResume once for a session built by resuming a task", async () => {
		const history = [userMsg("old"), assistantMsg("done"), userMsg("[TASK RESUMPTION] Please continue where you left off.")]
		const hooks = buildAgentHooks(stateManager, emit, undefined, { taskResumed: true })

		await hooks.beforeRun?.({ snapshot: snapshotWith(history) } as never)
		expect(createdHookNames()).toEqual(["TaskResume"])

		// A later user prompt in the same session does not re-fire TaskResume.
		mocks.create.mockClear()
		await hooks.beforeRun?.({ snapshot: snapshotWith([...history, assistantMsg("ok"), userMsg("more")]) } as never)
		expect(createdHookNames()).toEqual(["UserPromptSubmit"])
	})

	it("does not fire TaskResume on a session rebuild of a live task", async () => {
		const hooks = buildAgentHooks(stateManager, emit)
		await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("old"), assistantMsg("done"), userMsg("again")]) } as never)
		expect(createdHookNames()).toEqual(["UserPromptSubmit"])
	})

	it("does not fire UserPromptSubmit for synthetic prompts", async () => {
		const hooks = buildAgentHooks(stateManager, emit)
		await hooks.beforeRun?.({
			snapshot: snapshotWith([
				userMsg("hi"),
				assistantMsg("ok"),
				userMsg("[TASK RESUMPTION] Please continue where you left off."),
			]),
		} as never)
		expect(createdHookNames()).toEqual([])
	})

	it("does not fire UserPromptSubmit when the tail message is a tool result", async () => {
		const hooks = buildAgentHooks(stateManager, emit)
		await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("hi"), assistantMsg("ok"), toolResultMsg()]) } as never)
		expect(createdHookNames()).toEqual([])
	})

	it("does not refire UserPromptSubmit on a rebuild rerun of the same unanswered prompt", async () => {
		const messages = [userMsg("hi")]
		await buildAgentHooks(stateManager, emit).beforeRun?.({ snapshot: snapshotWith(messages) } as never)
		expect(createdHookNames()).toContain("UserPromptSubmit")

		mocks.create.mockClear()
		// Rebuilt session replays the same transcript tail prompt at the same index.
		await buildAgentHooks(stateManager, emit).beforeRun?.({ snapshot: snapshotWith(messages) } as never)
		expect(createdHookNames()).toEqual([])
	})

	it("emits no hook_status row for a quiet successful hook", async () => {
		const hooks = buildAgentHooks(stateManager, emit)
		await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("hi")]) } as never)
		expect(emitMock).not.toHaveBeenCalled()
	})

	it("emits a failed row when a hook throws", async () => {
		runner.run.mockRejectedValue(new Error("boom"))
		const hooks = buildAgentHooks(stateManager, emit)
		await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("hi")]) } as never)

		const texts = emitMock.mock.calls.map((c) => JSON.parse(c[0].text ?? "{}"))
		expect(texts).toContainEqual(expect.objectContaining({ hookName: "TaskStart", status: "failed" }))
		expect(texts).toContainEqual(expect.objectContaining({ hookName: "UserPromptSubmit", status: "failed" }))
	})

	it("emits a completed row when the hook modifies context", async () => {
		runner.run.mockResolvedValue({ cancel: false, contextModification: "extra context", errorMessage: "" })
		const hooks = buildAgentHooks(stateManager, emit)
		await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("hi")]) } as never)

		const texts = emitMock.mock.calls.map((c) => JSON.parse(c[0].text ?? "{}"))
		expect(texts).toContainEqual(expect.objectContaining({ hookName: "TaskStart", status: "completed" }))
		expect(texts).toContainEqual(expect.objectContaining({ hookName: "UserPromptSubmit", status: "completed" }))
	})

	it("emits a cancelled row when the hook cancels", async () => {
		runner.run.mockResolvedValue({ cancel: true, contextModification: "", errorMessage: "stop" })
		const hooks = buildAgentHooks(stateManager, emit)
		const result = await hooks.beforeRun?.({ snapshot: snapshotWith([userMsg("hi")]) } as never)

		expect(result?.stop).toBe(true)
		const texts = emitMock.mock.calls.map((c) => JSON.parse(c[0].text ?? "{}"))
		expect(texts).toContainEqual(expect.objectContaining({ hookName: "TaskStart", status: "cancelled" }))
	})
})
