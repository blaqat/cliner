import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useChatState } from "./useChatState"

describe("useChatState draft snapshots", () => {
	it("snapshots a mutation immediately, before React renders again", () => {
		const { result } = renderHook(() => useChatState([]))
		let snapshot = result.current.getDraftSnapshot()

		act(() => {
			result.current.setInputValue("latest text")
			snapshot = result.current.getDraftSnapshot()
		})

		expect(snapshot.text).toBe("latest text")
		expect(snapshot.revision).toBeGreaterThan(0)
	})

	it("consumes an acknowledged snapshot when the draft has not changed", () => {
		const { result } = renderHook(() => useChatState([]))

		act(() => {
			result.current.setInputValue("feedback")
			result.current.setQuotes([{ text: "selected context", note: "" }])
			result.current.setSelectedImages(["image.png"])
			result.current.setSelectedFiles(["notes.md"])
		})
		const snapshot = result.current.getDraftSnapshot()

		act(() => result.current.consumeDraftSnapshot(snapshot))

		expect(result.current.inputValue).toBe("")
		expect(result.current.quotes).toEqual([])
		expect(result.current.selectedImages).toEqual([])
		expect(result.current.selectedFiles).toEqual([])
	})

	it("preserves a newer draft even when its text returns to the submitted value", () => {
		const { result } = renderHook(() => useChatState([]))

		act(() => result.current.setInputValue("same text"))
		const submitted = result.current.getDraftSnapshot()
		act(() => {
			result.current.setInputValue("different text")
			result.current.setInputValue("same text")
		})

		act(() => result.current.consumeDraftSnapshot(submitted))

		expect(result.current.inputValue).toBe("same text")
	})
})

describe("useChatState explicit composer grants", () => {
	it("records a picked thread only while its token is in the text", () => {
		const { result } = renderHook(() => useChatState([]))
		act(() => result.current.setInputValue("see thread:1_a"))
		act(() => result.current.authorizeThread("1_a"))
		act(() => result.current.authorizeThread("2_never_inserted"))
		expect(result.current.getDraftSnapshot().authorizedThreadIds).toEqual(["1_a"])

		act(() => result.current.setInputValue("see it"))
		expect(result.current.getDraftSnapshot().authorizedThreadIds).toEqual([])
		// Typing the token back by hand does not bring the pick back.
		act(() => result.current.setInputValue("see thread:1_a"))
		expect(result.current.getDraftSnapshot().authorizedThreadIds).toEqual([])
	})

	it("clears picks and the script run when the draft is consumed", () => {
		const { result } = renderHook(() => useChatState([]))
		act(() => result.current.setInputValue("/deploy env:prod thread:1_a"))
		act(() => result.current.authorizeThread("1_a"))
		act(() => result.current.setScriptRun({ name: "deploy", values: { env: "prod" } }))
		act(() => result.current.consumeDraftSnapshot(result.current.getDraftSnapshot()))
		expect(result.current.getDraftSnapshot().authorizedThreadIds).toEqual([])
		expect(result.current.getDraftSnapshot().scriptRun).toBeUndefined()
	})

	it("drops the script run when the script prefix is edited away", () => {
		const { result } = renderHook(() => useChatState([]))
		act(() => result.current.setInputValue("/deploy env:prod"))
		act(() => result.current.setScriptRun({ name: "deploy", values: { env: "prod" } }))
		act(() => result.current.setInputValue("/deploy env:prod\nnote"))
		expect(result.current.getDraftSnapshot().scriptRun).toBeDefined()
		act(() => result.current.setInputValue("/deployx env:prod"))
		expect(result.current.getDraftSnapshot().scriptRun).toBeUndefined()
	})

	it("restores the grants of a draft whose send failed", () => {
		const { result } = renderHook(() => useChatState([]))
		act(() => result.current.setInputValue("see thread:1_a"))
		act(() => result.current.authorizeThread("1_a"))
		const grants = result.current.getDraftSnapshot()
		act(() => result.current.setInputValue(""))
		act(() => result.current.setInputValue("see thread:1_a"))
		act(() => result.current.restoreAuthorization(grants))
		expect(result.current.getDraftSnapshot().authorizedThreadIds).toEqual(["1_a"])
	})
})
