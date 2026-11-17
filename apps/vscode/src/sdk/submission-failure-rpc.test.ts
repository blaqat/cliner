import { AskResponseRequest, NewTaskRequest } from "@shared/proto/cline/task"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "@/core/controller"
import { askResponse } from "@/core/controller/task/askResponse"
import { newTask } from "@/core/controller/task/newTask"

// The webview hands the draft back when these RPCs reject, so a send that never got through has to reject.
describe("a submission that never reached a session", () => {
	it("newTask asks to hear about a failed start, and rejects with it", async () => {
		const initTask = vi.fn().mockRejectedValue(new Error("Storage is busy in another window. Try again shortly."))
		const controller = { initTask } as unknown as Controller
		await expect(newTask(controller, NewTaskRequest.create({ text: "hello" }))).rejects.toThrow("Storage is busy")
		expect(initTask.mock.calls[0][5]).toMatchObject({ rethrowStartFailure: true })
	})

	it("askResponse rejects when the follow-up failed, and resolves when it didn't", async () => {
		const takeFollowUpFailure = vi.fn(() => "Storage is busy in another window. Try again shortly.")
		const controller = {
			task: { taskId: "t", handleWebviewAskResponse: vi.fn(async () => {}) },
			takeFollowUpFailure,
		} as unknown as Controller
		const request = AskResponseRequest.create({ responseType: "messageResponse", text: "hello" })
		await expect(askResponse(controller, request)).rejects.toThrow("Storage is busy")
		takeFollowUpFailure.mockReturnValue(undefined as never)
		await expect(askResponse(controller, request)).resolves.toBeDefined()
	})
})
