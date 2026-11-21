import { act, cleanup, render } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { ExtensionStateContextProvider, useExtensionState } from "@/context/ExtensionStateContext"

const h = vi.hoisted(() => ({ receive: null as any, receiveChat: null as any }))
vi.mock("@/services/grpc-client", () => {
	const client = new Proxy(
		{},
		{
			get: (_, key) =>
				key === "subscribeToState" || key === "subscribeToChatButtonClicked"
					? (_: any, cb: any) => {
							if (key === "subscribeToState") h.receive = cb.onResponse
							else h.receiveChat = cb.onResponse
							return () => {}
						}
					: String(key).startsWith("subscribe")
						? () => () => {}
						: () => Promise.resolve({ profiles: [], models: {}, results: [] }),
		},
	)
	return {
		StateServiceClient: client,
		UiServiceClient: client,
		ModelsServiceClient: client,
		McpServiceClient: client,
		TaskServiceClient: client,
		TaskGroupServiceClient: client,
		WorktreeServiceClient: client,
	}
})

it.each(["saved thread", "side thread"])("keeps the %s visible after the host reveals chat", async (id) => {
	let state: ReturnType<typeof useExtensionState>
	const Probe = () => {
		state = useExtensionState()
		return null
	}
	const view = render(
		<ExtensionStateContextProvider>
			<Probe />
		</ExtensionStateContextProvider>,
	)
	try {
		act(() => state.navigateToHistory())
		await act(async () => {
			h.receive({
				stateJson: JSON.stringify({
					...state,
					version: "test",
					welcomeViewCompleted: true,
					currentTaskItem: { id },
					clineMessages: [{ ts: 10, type: "say", say: "task", text: id }],
				}),
			})
			h.receiveChat({})
		})
		expect(state!.showHistory).toBe(false)
		expect(state!.currentTaskItem?.id).toBe(id)
		expect(state!.clineMessages).toMatchObject([{ text: id }])

		act(() => h.receiveChat({ goHome: true }))
		expect(state!.currentTaskItem).toBeUndefined()
		expect(state!.clineMessages).toEqual([])
		act(() => h.receiveChat({}))
		expect(state!.currentTaskItem).toBeUndefined()
	} finally {
		view.unmount()
	}
})
it("preserves history identity and waits for the host value on settings clicks", async () => {
	vi.spyOn(console, "log").mockImplementation(() => {})
	let state: any
	const Probe = () => {
		state = useExtensionState()
		return null
	}
	render(
		<ExtensionStateContextProvider>
			<Probe />
		</ExtensionStateContextProvider>,
	)
	const history = [{ id: "one", ts: 1, task: "hello", tokensIn: 0, tokensOut: 0, totalCost: 0 }]
	await act(async () =>
		h.receive({
			stateJson: JSON.stringify({
				...state,
				taskHistory: history,
				taskHistoryVersion: "1",
				welcomeViewCompleted: true,
				hooksEnabled: false,
				currentTaskItem: history[0],
			}),
		}),
	)
	const original = state.taskHistory
	await act(async () => h.receive({ stateJson: JSON.stringify({ taskHistoryVersion: "1", hooksEnabled: true }) }))
	expect(state.hooksEnabled).toBe(true)
	expect(state.taskHistory).toBe(original)
	await act(async () => h.receive({ stateJson: JSON.stringify({ taskHistoryVersion: "2", taskHistory: [] }) }))
	expect(state.taskHistory).toEqual([])
	expect(state.taskHistory).not.toBe(original)
	await act(async () => h.receive({ stateJson: JSON.stringify({ taskHistory: history }) }))
	expect(state.taskHistory).toEqual(history)
	expect(state.taskHistoryVersion).toBeUndefined()
	await act(async () =>
		h.receive({ stateJson: JSON.stringify({ ...state, version: "test", currentTaskItem: undefined, taskHistory: history }) }),
	)
	expect(state.currentTaskItem).toBeUndefined()
	cleanup()
})

it("shows home immediately through stale snapshots and closes every overlay", async () => {
	let state: any
	const Probe = () => {
		state = useExtensionState()
		return null
	}
	render(
		<ExtensionStateContextProvider>
			<Probe />
		</ExtensionStateContextProvider>,
	)
	const snapshot = {
		...state,
		version: "test",
		welcomeViewCompleted: true,
		currentTaskItem: { id: "running" },
		clineMessages: [{ ts: 10, type: "say", say: "task", text: "Running" }],
	}
	await act(async () => h.receive({ stateJson: JSON.stringify(snapshot) }))
	act(() => state.navigateToSettings())
	act(() => state.navigateHome())
	expect(state.showSettings).toBe(false)
	expect(state.currentTaskItem).toBeUndefined()
	expect(state.clineMessages).toEqual([])
	await act(async () => h.receive({ stateJson: JSON.stringify(snapshot) }))
	expect(state.currentTaskItem).toBeUndefined()
	expect(state.clineMessages).toEqual([])
	await act(async () =>
		h.receive({ stateJson: JSON.stringify({ ...snapshot, currentTaskItem: undefined, clineMessages: [], epoch: 100 }) }),
	)
	expect(state.currentTaskItem).toBeUndefined()
	cleanup()
})
