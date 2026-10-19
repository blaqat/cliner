import { describe, expect, it } from "vitest"
import { restoredThreadStatus } from "./sdk-restored-status"

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
