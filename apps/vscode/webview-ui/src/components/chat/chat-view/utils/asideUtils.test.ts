import { describe, expect, it, vi } from "vitest"
import { recentlyStoppedIds } from "@/components/toasts/threadToastRules"
import { closeSideThread } from "./asideUtils"

vi.mock("@/services/grpc-client", () => ({
	SideThreadServiceClient: { updateSideThread: vi.fn().mockResolvedValue({}) },
	TaskServiceClient: {},
}))

describe("closeSideThread", () => {
	it("counts as a stop, so the side thread doesn't toast Finished", async () => {
		await closeSideThread("side-1")
		expect(recentlyStoppedIds().has("side-1")).toBe(true)
	})
})
