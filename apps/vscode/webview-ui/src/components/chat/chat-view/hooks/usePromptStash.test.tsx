import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PromptStashEntry } from "../utils/promptStash"
import { resetPromptStashForTests, usePromptStash } from "./usePromptStash"

const mocks = vi.hoisted(() => ({
	promptStash: undefined as PromptStashEntry[] | undefined,
	updateSettings: vi.fn((_request: unknown) => Promise.resolve({})),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ promptStash: mocks.promptStash }),
}))

vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: (request: unknown) => mocks.updateSettings(request) },
}))

describe("usePromptStash", () => {
	beforeEach(() => {
		mocks.promptStash = undefined
		mocks.updateSettings.mockClear()
		resetPromptStashForTests()
	})

	it("stashes non-empty drafts only", () => {
		const { result } = renderHook(() => usePromptStash("task-1"))

		let stashed = false
		act(() => {
			stashed = result.current.stash({ text: "  ", quotes: [] })
		})
		expect(stashed).toBe(false)
		expect(result.current.entries).toEqual([])

		act(() => {
			stashed = result.current.stash({ text: "draft", quotes: [{ text: "q", note: "" }] })
		})
		expect(stashed).toBe(true)
		expect(result.current.entries).toHaveLength(1)
		expect(result.current.entries[0]).toMatchObject({ text: "draft", quotes: [{ text: "q", note: "" }], taskId: "task-1" })
	})

	it("is shared across composers (global stash)", () => {
		const first = renderHook(() => usePromptStash("task-1"))
		const second = renderHook(() => usePromptStash("task-2"))

		act(() => {
			first.result.current.stash({ text: "from task 1", quotes: [] })
		})

		expect(second.result.current.entries.map((e) => e.text)).toEqual(["from task 1"])
	})

	it("restores (removing the entry and swapping the current draft in) and deletes", () => {
		const { result } = renderHook(() => usePromptStash())
		act(() => {
			result.current.stash({ text: "one", quotes: [] })
		})
		const id = result.current.entries[0].id

		let restoredText: string | undefined
		act(() => {
			restoredText = result.current.restore(id, { text: "typed meanwhile", quotes: [] })?.text
		})
		expect(restoredText).toBe("one")
		expect(result.current.entries.map((e) => e.text)).toEqual(["typed meanwhile"])

		act(() => result.current.remove(result.current.entries[0].id))
		expect(result.current.entries).toEqual([])
	})

	it("persists changes through updateSettings", () => {
		const { result } = renderHook(() => usePromptStash())

		act(() => {
			result.current.stash({ text: "keep me", quotes: [] })
		})

		expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
		expect(mocks.updateSettings.mock.calls[0][0]).toMatchObject({
			promptStash: { entries: [expect.objectContaining({ text: "keep me" })] },
		})
	})

	it("mirrors the stash posted by the host without writing it back", () => {
		mocks.promptStash = [{ id: "h1", text: "from host", quotes: [], ts: 1 }]
		const { result } = renderHook(() => usePromptStash())

		expect(result.current.entries.map((e) => e.text)).toEqual(["from host"])
		expect(mocks.updateSettings).not.toHaveBeenCalled()
	})
})
