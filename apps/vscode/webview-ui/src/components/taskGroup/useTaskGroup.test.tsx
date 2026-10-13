import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatNoteSize, useTaskGroupPageNavigation } from "./useTaskGroup"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({ TaskGroupServiceClient: {} }))

type Props = { taskTs: number | undefined; view: { id: string; page: "home" | "notebook" } | null }

describe("useTaskGroupPageNavigation", () => {
	const closeThread = vi.fn()
	const onPageOpen = vi.fn()
	const navigateToTaskGroup = vi.fn()
	const hideTaskGroupView = vi.fn()

	const setup = (initial: Props) =>
		renderHook(
			({ taskTs, view }: Props) => {
				mocks.state = { taskGroupView: view, navigateToTaskGroup, hideTaskGroupView }
				return useTaskGroupPageNavigation({ taskTs, closeThread, onPageOpen })
			},
			{ initialProps: initial },
		)

	beforeEach(() => {
		closeThread.mockReset()
		onPageOpen.mockReset()
		navigateToTaskGroup.mockReset()
		hideTaskGroupView.mockReset()
	})

	it("opens the task page through the context navigation (every ChatView entry point uses this)", () => {
		const { result } = setup({ taskTs: undefined, view: null })
		result.current("g1")
		expect(navigateToTaskGroup).toHaveBeenCalledWith("g1")
	})

	it("opening the page from a thread goes home first so the composer starts a new thread", () => {
		const { rerender } = setup({ taskTs: 5, view: null })
		expect(closeThread).not.toHaveBeenCalled()
		rerender({ taskTs: 5, view: { id: "g1", page: "home" } })
		expect(closeThread).toHaveBeenCalledTimes(1)
		expect(onPageOpen).toHaveBeenCalledTimes(1)
		// The thread closing doesn't close the page.
		rerender({ taskTs: undefined, view: { id: "g1", page: "home" } })
		expect(hideTaskGroupView).not.toHaveBeenCalled()
		// Switching to the notebook page doesn't re-close anything.
		rerender({ taskTs: undefined, view: { id: "g1", page: "notebook" } })
		expect(closeThread).toHaveBeenCalledTimes(1)
	})

	it("opening from home leaves no thread to close", () => {
		const { rerender } = setup({ taskTs: undefined, view: null })
		rerender({ taskTs: undefined, view: { id: "g1", page: "home" } })
		expect(closeThread).not.toHaveBeenCalled()
		expect(onPageOpen).toHaveBeenCalledTimes(1)
	})

	it("a thread opening (timeline row, a send, the inbox) closes the page", () => {
		const { rerender } = setup({ taskTs: undefined, view: { id: "g1", page: "home" } })
		expect(hideTaskGroupView).not.toHaveBeenCalled()
		rerender({ taskTs: 42, view: { id: "g1", page: "home" } })
		expect(hideTaskGroupView).toHaveBeenCalledTimes(1)
	})
})

describe("formatNoteSize", () => {
	it("uses bytes under 1 KB, one decimal under 10 KB", () => {
		expect(formatNoteSize(820)).toBe("820 B")
		expect(formatNoteSize(1229)).toBe("1.2 KB")
		expect(formatNoteSize(20_480)).toBe("20 KB")
	})
})
