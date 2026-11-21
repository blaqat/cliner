import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SkillsetDropLayer } from "./SkillsetDropLayer"
import { skillsetToastCopy } from "./SkillsetToasts"
import { dismissSkillsetToast, getSkillsetState, setEatPhase, takeSkillsRequest } from "./skillsetStore"

const mocks = vi.hoisted(() => ({
	importSkillset: vi.fn(),
	reduced: false,
}))
vi.mock("@/services/grpc-client", () => ({
	SkillsetServiceClient: {
		importSkillset: mocks.importSkillset,
		subscribeToSkillsetImports: () => () => {},
	},
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ windowFocused: true }) }))
vi.mock("@/hooks/useReducedMotionPreference", () => ({ useReducedMotionPreference: () => mocks.reduced }))

const added = {
	fileName: "review-kit.skillset.zip",
	skills: 3,
	workflows: 1,
	alreadyHad: 0,
	set: { id: "s1", name: "review-kit", fileName: "review-kit.skillset.zip", addedAt: 1, items: [] },
}

/** A DataTransfer as Chromium gives it mid-drag (types only) and on drop (files). */
function transfer(file?: File) {
	return {
		types: file ? ["Files"] : ["application/vnd.code.uri-list"],
		items: file ? [{ kind: "file", type: "application/zip" }] : [],
		files: file ? [file] : [],
		dropEffect: "none",
		getData: () => "",
	}
}

function dispatch(type: string, dataTransfer: unknown, target: EventTarget = document.body) {
	const event = new Event(type, { bubbles: true, cancelable: true })
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer })
	act(() => {
		target.dispatchEvent(event)
	})
	return event
}

describe("SkillsetDropLayer", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		mocks.importSkillset.mockReset().mockResolvedValue({ json: JSON.stringify(added) })
		mocks.reduced = false
		setEatPhase("idle")
		for (const toast of getSkillsetState().toasts) dismissSkillsetToast(toast.id)
		takeSkillsRequest()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("claims a zip before the composer: the veil opens the logo's jaw, then it eats, sparkles and toasts", async () => {
		const composer = vi.fn()
		render(
			<>
				<div data-testid="composer-card" onDragEnter={composer} onDragOver={composer} onDrop={composer} />
				<SkillsetDropLayer />
			</>,
		)
		const zip = new File([new Uint8Array([80, 75, 5, 6])], "review-kit.skillset.zip", { type: "application/zip" })
		const card = screen.getByTestId("composer-card")
		const enter = dispatch("dragenter", transfer(zip), card)
		dispatch("dragover", transfer(zip), card)
		expect(enter.defaultPrevented).toBe(true)
		expect(composer).not.toHaveBeenCalled()
		expect(screen.getByTestId("skillset-veil")).toHaveAttribute("data-phase", "over")
		expect(screen.getByTestId("skillset-veil")).toHaveTextContent("Drop to add skills")
		expect(within(screen.getByTestId("skillset-veil")).getByTestId("eating-logo")).toHaveClass("is-open")

		dispatch("drop", transfer(zip), card)
		expect(composer).not.toHaveBeenCalled()
		await waitFor(() => expect(getSkillsetState().phase).toBe("eating"))
		await waitFor(() =>
			expect(mocks.importSkillset).toHaveBeenCalledWith(expect.objectContaining({ fileName: "review-kit.skillset.zip" })),
		)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})
		expect(getSkillsetState().phase).toBe("spark")
		expect(screen.queryByTestId("skillset-toast")).not.toBeInTheDocument()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1600)
		})
		// The toast comes after the sparkle, as the veil goes.
		expect(screen.getByTestId("skillset-toast")).toHaveTextContent("3 new skills unlocked")
		expect(getSkillsetState().phase).toBe("idle")
		expect(screen.queryByTestId("skillset-veil")).not.toBeInTheDocument()
	})

	it("leaves other drags alone and drops the veil when the drag leaves", async () => {
		render(<SkillsetDropLayer />)
		const image = { types: ["Files"], items: [{ kind: "file", type: "image/png" }], files: [], getData: () => "" }
		expect(dispatch("dragover", image).defaultPrevented).toBe(false)
		expect(screen.queryByTestId("skillset-veil")).not.toBeInTheDocument()
		const zip = new File(["x"], "a.zip", { type: "application/zip" })
		dispatch("dragover", transfer(zip))
		expect(screen.getByTestId("skillset-veil")).toBeInTheDocument()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400)
		})
		expect(screen.queryByTestId("skillset-veil")).not.toBeInTheDocument()
	})

	it("has a still version for reduced motion", () => {
		mocks.reduced = true
		render(<SkillsetDropLayer />)
		dispatch("dragover", transfer(new File(["x"], "a.zip", { type: "application/zip" })))
		expect(screen.getByTestId("skillset-veil")).toHaveClass("is-still")
		expect(within(screen.getByTestId("skillset-veil")).getByTestId("eating-logo")).toHaveClass("is-still")
	})

	it("explains a zip with no skills", async () => {
		mocks.importSkillset.mockResolvedValue({
			json: JSON.stringify({
				fileName: "notes.zip",
				skills: 0,
				workflows: 0,
				alreadyHad: 0,
				error: "No skills or workflows in it.",
			}),
		})
		render(<SkillsetDropLayer />)
		dispatch("drop", transfer(new File(["x"], "notes.zip", { type: "application/zip" })))
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})
		expect(getSkillsetState().phase).toBe("shake")
		expect(screen.getByTestId("skillset-toast")).toHaveTextContent("No skills in notes.zip")
		fireEvent.click(screen.getByTestId("skillset-toast-action"))
		expect(getSkillsetState().request).toEqual({ tab: "skills", setId: undefined })
	})
})

describe("skillsetToastCopy", () => {
	it("says what arrived", () => {
		expect(skillsetToastCopy(added)).toMatchObject({
			title: "3 new skills unlocked",
			detail: "+1 workflow · from review-kit",
			action: "View",
		})
		expect(skillsetToastCopy({ ...added, skills: 0, workflows: 2 }).title).toBe("2 new workflows unlocked")
		expect(skillsetToastCopy({ fileName: "a.skillset.zip", skills: 0, workflows: 0, alreadyHad: 2 }).title).toBe(
			"Nothing new in a",
		)
	})
})
