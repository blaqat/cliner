import { StopSubagentRequest } from "@shared/proto/cline/task"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from ".."
import { stopSubagent } from "./stopSubagent"

describe("stopSubagent handler", () => {
	const request = StopSubagentRequest.create({ taskId: "root", subagentId: "child" })

	it("resolves when the controller stopped the subagent", async () => {
		const controller = { stopSubagent: vi.fn().mockResolvedValue(true) } as unknown as Controller
		await expect(stopSubagent(controller, request)).resolves.toBeDefined()
		expect(controller.stopSubagent).toHaveBeenCalledWith("root", "child")
	})

	it("rejects when the subagent could not be stopped so the webview can retry", async () => {
		const controller = { stopSubagent: vi.fn().mockResolvedValue(false) } as unknown as Controller
		await expect(stopSubagent(controller, request)).rejects.toThrow("Subagent could not be stopped")
	})
})
