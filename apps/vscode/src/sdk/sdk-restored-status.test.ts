import { describe, expect, it } from "vitest"
import { lastTurnCompleted, restoredThreadStatus } from "./sdk-restored-status"

describe("restored thread status", () => {
	it.each([
		{ status: "idle", expected: "done" },
		{ status: "completed", expected: "done" },
		{ status: "running", expected: "stopped" },
		{ status: "pending", expected: "waiting" },
		{ status: "cancelled", expected: "stopped" },
		{ status: "failed", expected: "error" },
	] as const)("maps $status to $expected without a live run", ({ status, expected }) => {
		expect(restoredThreadStatus({ status })).toBe(expected)
	})

	it("preserves pending decisions through teardown while retaining genuine failures", () => {
		const metadata = { vscodeThreadStatus: "waiting" }
		expect(restoredThreadStatus({ status: "cancelled", metadata })).toBe("waiting")
		expect(restoredThreadStatus({ status: "running", metadata })).toBe("waiting")
		expect(restoredThreadStatus({ status: "failed", metadata })).toBe("error")
		expect(restoredThreadStatus({ status: "idle", metadata: { vscodeThreadStatus: "error" } })).toBe("error")
	})

	it("shows records an older build marked failed on window close as done, but keeps real errors", () => {
		const legacy = { terminal_marker: "failed_external_process_exit" }
		expect(restoredThreadStatus({ status: "failed", metadata: legacy })).toBe("done")
		expect(restoredThreadStatus({ status: "failed", metadata: { ...legacy, vscodeThreadStatus: "error" } })).toBe("error")
		expect(restoredThreadStatus({ status: "failed", metadata: { terminal_marker: "something_else" } })).toBe("error")
	})
})

describe("lastTurnCompleted", () => {
	it("trusts a gracefully released completed session", () => {
		expect(lastTurnCompleted({ status: "completed" })).toBe(true)
	})

	it("treats an idle record the extension marked done as completed (window reload case)", () => {
		expect(lastTurnCompleted({ status: "idle", metadata: { vscodeThreadStatus: "done" } })).toBe(true)
	})

	it.each([
		{ status: "idle", metadata: { vscodeThreadStatus: "stopped" } },
		{ status: "idle", metadata: { vscodeThreadStatus: "running" } },
		{ status: "idle", metadata: { vscodeThreadStatus: "waiting" } },
		{ status: "idle", metadata: { vscodeThreadStatus: "error" } },
		{ status: "idle", metadata: {} },
		{ status: "idle" },
		{ status: "cancelled", metadata: { vscodeThreadStatus: "done" } },
		{ status: "failed", metadata: { vscodeThreadStatus: "done" } },
		{ status: "running", metadata: { vscodeThreadStatus: "done" } },
		{ status: "pending", metadata: { vscodeThreadStatus: "done" } },
	] as const)("does not treat $status with $metadata as completed", (record) => {
		expect(lastTurnCompleted(record)).toBe(false)
	})
})
