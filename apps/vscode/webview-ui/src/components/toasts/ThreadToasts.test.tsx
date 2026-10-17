import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadToasts } from "./ThreadToasts"

const openTask = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock("@/components/inbox/sessionActions", () => ({ openTask }))

const navigateToChat = vi.fn()
const baseState = () => ({
	didHydrateState: true,
	sessionStatuses: {} as Record<string, string>,
	taskHistory: [
		{ id: "a", ts: 1, task: "Implement steps 1-2", taskGroupId: "t" },
		{ id: "b", ts: 2, task: "Repro on staging" },
		{ id: "c", ts: 3, task: "Third" },
		{ id: "d", ts: 4, task: "Fourth" },
	],
	taskGroups: [{ id: "t", title: "Bulk invoice export", tags: [], createdAt: 0, updatedAt: 0, noteCount: 0 }],
	currentTaskItem: undefined as { id: string } | undefined,
	windowFocused: true,
	threadToastsEnabled: true,
	threadToastSeconds: 5,
	navigateToChat,
})
let state = baseState()
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

function update(patch: Partial<ReturnType<typeof baseState>>, rerender: (ui: React.ReactElement) => void) {
	state = { ...state, ...patch }
	act(() => rerender(<ThreadToasts />))
}

function mountWith(statuses: Record<string, string>) {
	state = { ...baseState(), sessionStatuses: statuses }
	return render(<ThreadToasts />)
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

describe("ThreadToasts", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		openTask.mockClear()
		navigateToChat.mockClear()
	})
	afterEach(() => vi.useRealTimers())

	it("doesn't toast what was already done or waiting at load", () => {
		mountWith({ a: "done", b: "waiting" })
		expect(screen.queryByTestId("thread-toast")).toBeNull()
	})

	it("shows a completion toast with title and status, gone after the duration", () => {
		const { rerender } = mountWith({ a: "running" })
		update({ sessionStatuses: { a: "done" } }, rerender)
		const toast = screen.getByTestId("thread-toast")
		expect(toast).toHaveTextContent("Implement steps 1-2")
		expect(toast).toHaveTextContent("Finished · Bulk invoice export")
		advance(4900)
		expect(screen.queryByTestId("thread-toast")).not.toBeNull()
		advance(200)
		expect(screen.queryByTestId("thread-toast")).toBeNull()
	})

	it("pauses the timer while hovered", () => {
		const { rerender } = mountWith({ a: "running" })
		update({ sessionStatuses: { a: "done" } }, rerender)
		advance(3000)
		fireEvent.mouseEnter(screen.getByTestId("thread-toast"))
		advance(10_000)
		expect(screen.queryByTestId("thread-toast")).not.toBeNull()
		fireEvent.mouseLeave(screen.getByTestId("thread-toast"))
		advance(1900)
		expect(screen.queryByTestId("thread-toast")).not.toBeNull()
		advance(200)
		expect(screen.queryByTestId("thread-toast")).toBeNull()
	})

	it("shows toasts while VS Code is unfocused but starts the timer on focus", () => {
		const { rerender } = mountWith({ a: "running" })
		update({ windowFocused: false }, rerender)
		update({ sessionStatuses: { a: "done" } }, rerender)
		expect(screen.getByTestId("thread-toast")).toBeInTheDocument()
		advance(60_000)
		expect(screen.queryByTestId("thread-toast")).not.toBeNull()
		update({ windowFocused: true }, rerender)
		advance(4900)
		expect(screen.queryByTestId("thread-toast")).not.toBeNull()
		advance(200)
		expect(screen.queryByTestId("thread-toast")).toBeNull()
	})

	it("keeps needs-input toasts until the thread is handled", () => {
		const { rerender } = mountWith({ b: "running" })
		update({ sessionStatuses: { b: "waiting" } }, rerender)
		const toast = screen.getByTestId("thread-toast")
		expect(toast).toHaveTextContent("Needs input")
		expect(screen.getByTestId("thread-toast-open")).toHaveTextContent("Review")
		advance(120_000)
		expect(screen.queryByTestId("thread-toast")).not.toBeNull()
		update({ sessionStatuses: { b: "running" } }, rerender)
		expect(screen.queryByTestId("thread-toast")).toBeNull()
	})

	it("closes with ✕", () => {
		const { rerender } = mountWith({ b: "running" })
		update({ sessionStatuses: { b: "waiting" } }, rerender)
		fireEvent.click(screen.getByTestId("thread-toast-close"))
		expect(screen.queryByTestId("thread-toast")).toBeNull()
	})

	it("never toasts the thread on screen, failures, or when turned off", () => {
		const { rerender } = mountWith({ a: "running", b: "running" })
		update({ currentTaskItem: { id: "a" }, sessionStatuses: { a: "done", b: "error" } }, rerender)
		expect(screen.queryByTestId("thread-toast")).toBeNull()
		update({ threadToastsEnabled: false, sessionStatuses: { a: "done", b: "running" } }, rerender)
		update({ sessionStatuses: { a: "done", b: "done" } }, rerender)
		expect(screen.queryByTestId("thread-toast")).toBeNull()
	})

	it("stacks at most three, newest on top", () => {
		const { rerender } = mountWith({ a: "running", b: "running", c: "running", d: "running" })
		update({ sessionStatuses: { a: "done", b: "running", c: "running", d: "running" } }, rerender)
		update({ sessionStatuses: { a: "done", b: "waiting", c: "running", d: "running" } }, rerender)
		update({ sessionStatuses: { a: "done", b: "waiting", c: "done", d: "running" } }, rerender)
		update({ sessionStatuses: { a: "done", b: "waiting", c: "done", d: "waiting" } }, rerender)
		const titles = screen.getAllByTestId("thread-toast").map((toast) => toast.textContent)
		expect(titles).toHaveLength(3)
		expect(titles[0]).toContain("Fourth")
		expect(titles[2]).toContain("Repro on staging")
	})

	it("opens the thread from the action and dismisses the toast", () => {
		const { rerender } = mountWith({ a: "running" })
		update({ sessionStatuses: { a: "done" } }, rerender)
		fireEvent.click(screen.getByTestId("thread-toast-open"))
		expect(navigateToChat).toHaveBeenCalled()
		expect(openTask).toHaveBeenCalledWith("a")
		expect(screen.queryByTestId("thread-toast")).toBeNull()
	})
})
