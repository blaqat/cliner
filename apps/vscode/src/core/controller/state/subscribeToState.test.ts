import { describe, expect, it, vi } from "vitest"
import type { ExtensionStateUpdate } from "@/shared/ExtensionMessage"
import { sendStateUpdate, subscribeToState } from "./subscribeToState"

const cleanups = vi.hoisted(() => new Map<string, () => void>())
vi.mock("@/services/telemetry", () => ({ telemetryService: { captureGrpcResponseSize: vi.fn() } }))
vi.mock("../grpc-handler", () => ({
	getRequestRegistry: () => ({ registerRequest: (id: string, cleanup: () => void) => cleanups.set(id, cleanup) }),
}))
vi.mock("@/shared/services/Logger", () => ({ Logger: { error: vi.fn() } }))

const snapshot = (version = "1"): ExtensionStateUpdate => ({
	taskHistoryVersion: version,
	taskHistory: [],
	sessionStatuses: {},
	subagentCounts: {},
	oneViewEnabled: false,
})
const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("state history transport", () => {
	it("sends history on first delivery and changes, omits unchanged history independently per subscription", async () => {
		const stream = vi.fn().mockResolvedValue(undefined)
		const controller = { getStateToPostToWebview: async () => snapshot() }
		await subscribeToState(controller as never, {}, stream, "first")
		await sendStateUpdate({ ...snapshot(), oneViewEnabled: true })
		await settle()
		expect(JSON.parse(stream.mock.calls[1][0].stateJson)).toEqual({ taskHistoryVersion: "1", oneViewEnabled: true })
		const second = vi.fn().mockResolvedValue(undefined)
		await subscribeToState(controller as never, {}, second, "second")
		expect(JSON.parse(second.mock.calls[0][0].stateJson).taskHistory).toEqual([])
		await sendStateUpdate(snapshot("2"))
		await settle()
		expect(JSON.parse(stream.mock.calls[2][0].stateJson).taskHistory).toEqual([])
		await sendStateUpdate({ oneViewEnabled: false })
		await settle()
		await sendStateUpdate(snapshot("3"))
		await settle()
		expect(JSON.parse(stream.mock.calls[4][0].stateJson).taskHistory).toEqual([])
		await sendStateUpdate({ taskHistory: [] })
		await settle()
		expect(JSON.parse(stream.mock.calls[5][0].stateJson).taskHistory).toEqual([])
		cleanups.get("first")!()
		cleanups.get("second")!()
	})
	it("keeps live fields fresh and never acknowledges history from a partial post", async () => {
		const stream = vi.fn().mockResolvedValue(undefined)
		await subscribeToState({ getStateToPostToWebview: async () => snapshot() } as never, {}, stream, "partial")
		await sendStateUpdate({ taskHistoryVersion: "2", sessionStatuses: { live: "running" } })
		await settle()
		expect(JSON.parse(stream.mock.calls[1][0].stateJson).sessionStatuses).toEqual({ live: "running" })
		await sendStateUpdate(snapshot("2"))
		await settle()
		expect(JSON.parse(stream.mock.calls[2][0].stateJson).taskHistory).toEqual([])
		cleanups.get("partial")!()
	})

	it("queues behind the first successful full post and removes failed subscriptions", async () => {
		let finish!: () => void
		const stream = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve
					}),
			)
			.mockResolvedValue(undefined)
		const initial = subscribeToState({ getStateToPostToWebview: async () => snapshot() } as never, {}, stream, "queued")
		await settle()
		await sendStateUpdate(snapshot())
		await settle()
		expect(stream).toHaveBeenCalledTimes(1)
		finish()
		await initial
		await settle()
		expect(JSON.parse(stream.mock.calls[1][0].stateJson).taskHistory).toBeUndefined()
		cleanups.get("queued")!()
		const failed = vi.fn().mockRejectedValue(new Error("closed"))
		await subscribeToState({ getStateToPostToWebview: async () => snapshot() } as never, {}, failed)
		await sendStateUpdate(snapshot())
		await settle()
		expect(failed).toHaveBeenCalledTimes(1)
	})
})
