import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useLeaveDeletedThread } from "./useLeaveDeletedThread"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))

type Deleted = { id: string; taskGroupId?: string; seq: number } | undefined
type Props = { deleted: Deleted; groups?: string[]; hydrated?: boolean }

describe("useLeaveDeletedThread", () => {
	const openTaskGroup = vi.fn()
	const goHome = vi.fn()

	const setup = (initial: Props) =>
		renderHook(
			({ deleted, groups = ["g1"], hydrated = true }: Props) => {
				mocks.state = {
					deletedOpenThread: deleted,
					taskGroups: groups.map((id) => ({ id })),
					didHydrateState: hydrated,
				}
				useLeaveDeletedThread({ openTaskGroup, goHome })
			},
			{ initialProps: initial },
		)

	beforeEach(() => {
		openTaskGroup.mockReset()
		goHome.mockReset()
	})

	it("does not navigate for a delete that predates this webview", () => {
		const { rerender } = setup({ deleted: { id: "t1", taskGroupId: "g1", seq: 4 } })
		rerender({ deleted: { id: "t1", taskGroupId: "g1", seq: 4 } })
		expect(openTaskGroup).not.toHaveBeenCalled()
		expect(goHome).not.toHaveBeenCalled()
	})

	it("treats the first hydrated state as history even when state arrives after mount", () => {
		const { rerender } = setup({ deleted: undefined, hydrated: false })
		rerender({ deleted: { id: "t1", taskGroupId: "g1", seq: 2 }, hydrated: true })
		expect(openTaskGroup).not.toHaveBeenCalled()
		expect(goHome).not.toHaveBeenCalled()
		rerender({ deleted: { id: "t2", taskGroupId: "g1", seq: 3 }, hydrated: true })
		expect(openTaskGroup).toHaveBeenCalledTimes(1)
	})

	it("opens the task page when the deleted thread's task still exists", () => {
		const { rerender } = setup({ deleted: undefined })
		rerender({ deleted: { id: "t1", taskGroupId: "g1", seq: 1 } })
		expect(openTaskGroup).toHaveBeenCalledWith("g1")
		expect(goHome).not.toHaveBeenCalled()
	})

	it("goes home when the thread had no task, or its task is gone", () => {
		const { rerender } = setup({ deleted: undefined })
		rerender({ deleted: { id: "t1", seq: 1 } })
		expect(goHome).toHaveBeenCalledTimes(1)
		rerender({ deleted: { id: "t2", taskGroupId: "gone", seq: 2 } })
		expect(goHome).toHaveBeenCalledTimes(2)
		expect(openTaskGroup).not.toHaveBeenCalled()
	})

	it("reacts once per seq and again for the next delete", () => {
		const { rerender } = setup({ deleted: undefined })
		rerender({ deleted: { id: "t1", taskGroupId: "g1", seq: 1 } })
		rerender({ deleted: { id: "t1", taskGroupId: "g1", seq: 1 }, groups: ["g1", "g2"] })
		expect(openTaskGroup).toHaveBeenCalledTimes(1)
		rerender({ deleted: { id: "t3", taskGroupId: "g1", seq: 2 } })
		expect(openTaskGroup).toHaveBeenCalledTimes(2)
	})

	it("ignores older snapshots after handling a newer delete", () => {
		const { rerender } = setup({ deleted: undefined })
		rerender({ deleted: { id: "t2", seq: 2 } })
		rerender({ deleted: { id: "t1", taskGroupId: "g1", seq: 1 } })
		rerender({ deleted: { id: "t2", seq: 2 } })
		expect(goHome).toHaveBeenCalledTimes(1)
		expect(openTaskGroup).not.toHaveBeenCalled()
	})

	it("a state with no deletedOpenThread (deleting a different thread) never navigates", () => {
		const { rerender } = setup({ deleted: { id: "t1", seq: 1 } })
		rerender({ deleted: { id: "t1", seq: 1 } })
		rerender({ deleted: undefined })
		expect(goHome).not.toHaveBeenCalled()
		expect(openTaskGroup).not.toHaveBeenCalled()
	})
})
