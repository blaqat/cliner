import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { getComposerTaskGroup, setComposerTaskGroup, useClearComposerTaskOnLeavingTask } from "./composerTaskGroup"

describe("useClearComposerTaskOnLeavingTask", () => {
	afterEach(() => setComposerTaskGroup(undefined))

	it("drops the composer's task pick when you leave a task for home", () => {
		const { rerender } = renderHook(({ inTask }) => useClearComposerTaskOnLeavingTask(inTask), {
			initialProps: { inTask: "task-1" as string | undefined },
		})
		setComposerTaskGroup("task-1")
		rerender({ inTask: undefined })
		expect(getComposerTaskGroup()).toBeUndefined()
	})

	it("keeps a pick made on home, where there's no task to leave", () => {
		const { rerender } = renderHook(({ inTask }) => useClearComposerTaskOnLeavingTask(inTask), {
			initialProps: { inTask: undefined as string | undefined },
		})
		setComposerTaskGroup("task-2")
		rerender({ inTask: undefined })
		expect(getComposerTaskGroup()).toBe("task-2")
	})
})
