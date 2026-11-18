import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it, vi } from "vitest"
import { Controller } from "./SdkController"

const item = (id: string, fields: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...fields,
})

function controllerWith(items: HistoryItem[], session?: { isRunning: boolean }) {
	const byId = new Map(items.map((entry) => [entry.id, entry]))
	const fireAndForgetSend = vi.fn()
	const abort = vi.fn(async () => {})
	const appendAndEmit = vi.fn()
	const turnSet = vi.fn()
	const live = session ? { ...session, sdkHost: { abort } } : undefined
	const controller = Object.create(Controller.prototype)
	Object.assign(controller, {
		focusedTask: undefined,
		taskHistory: {
			findHistoryItem: async (id: string) => byId.get(id),
			updateTaskHistoryItem: vi.fn(async (next: HistoryItem) => void byId.set(next.id, next)),
			markTaskActive: vi.fn(async () => {}),
			markUserMessage: vi.fn(async () => {}),
		},
		sessions: { assertTaskAvailable: () => {}, getSession: () => live, fireAndForgetSend },
		getTaskSessionContext: () => ({
			translator: { clearTurnOutcome: vi.fn() },
			turn: { set: turnSet },
			messages: { appendAndEmit },
		}),
		resolveContextMentions: async (text: string) => text,
		saveSideThreadNote: vi.fn(async () => {}),
		postStateToWebview: vi.fn(async () => {}),
	})
	return { controller, byId, fireAndForgetSend, abort, appendAndEmit, turnSet }
}

describe("side threads in the controller", () => {
	it("sends an approved note to the original Main, even from a nested side thread", async () => {
		const { controller } = controllerWith([
			item("main"),
			item("side", { parentTaskId: "main" }),
			item("nested", { parentTaskId: "side" }),
		])
		await controller.sendSideThreadNote("nested", "  Keep 500ms.  ")
		expect(controller.saveSideThreadNote).toHaveBeenCalledWith("main", "nested", "Keep 500ms.")
		await expect(controller.sendSideThreadNote("main", "x")).rejects.toThrow("no main thread")
		await expect(controller.sendSideThreadNote("side", "   ")).rejects.toThrow("1 to 4000")
	})

	it("sends to an idle side thread in the background: shows the message and starts its turn", async () => {
		const { controller, fireAndForgetSend, appendAndEmit, turnSet, byId } = controllerWith(
			[item("main"), item("side", { parentTaskId: "main", task: "From a message" })],
			{ isRunning: false },
		)
		await controller.sendToSideThread("side", "Is 500ms too short?")
		expect(appendAndEmit).toHaveBeenCalledWith(
			[expect.objectContaining({ say: "user_feedback", text: "Is 500ms too short?" })],
			expect.anything(),
		)
		expect(turnSet).toHaveBeenCalledWith("streaming")
		expect(fireAndForgetSend).toHaveBeenCalledWith(expect.anything(), "side", "Is 500ms too short?", undefined, undefined)
		// Its first own message titles it.
		expect(byId.get("side")?.task).toBe("Is 500ms too short?")
	})

	it("queues onto a running side thread and refuses a thread with no live session", async () => {
		const running = controllerWith([item("main"), item("side", { parentTaskId: "main" })], { isRunning: true })
		await running.controller.sendToSideThread("side", "one more")
		expect(running.fireAndForgetSend).toHaveBeenCalledWith(
			expect.anything(),
			"side",
			"one more",
			undefined,
			undefined,
			"queue",
		)
		expect(running.appendAndEmit).not.toHaveBeenCalled()

		const stopped = controllerWith([item("main"), item("side", { parentTaskId: "main" })])
		await expect(stopped.controller.sendToSideThread("side", "hi")).rejects.toThrow("isn't running")
		await expect(stopped.controller.sendToSideThread("main", "hi")).rejects.toThrow("Only side threads")
	})

	it("keeps a side question, and closing a running side thread stops it", async () => {
		const { controller, byId, abort } = controllerWith(
			[item("main"), item("btw", { parentTaskId: "main", sideKind: "btw" })],
			{ isRunning: true },
		)
		await controller.updateSideThread("btw", { kind: "side" })
		expect(byId.get("btw")?.sideKind).toBe("side")
		expect(abort).not.toHaveBeenCalled()
		await controller.updateSideThread("btw", { closed: true })
		expect(abort).toHaveBeenCalledWith("btw")
		expect(byId.get("btw")?.sideClosedAt).toBeGreaterThan(0)
		await controller.updateSideThread("btw", { closed: false })
		expect(byId.get("btw")?.sideClosedAt).toBeUndefined()
	})
})
