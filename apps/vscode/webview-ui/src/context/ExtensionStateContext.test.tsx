import { act, cleanup, render } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { ExtensionStateContextProvider, useExtensionState } from "@/context/ExtensionStateContext"

const h = vi.hoisted(() => ({ receive: null as any }))
vi.mock("@/services/grpc-client", () => {
	const client = new Proxy(
		{},
		{
			get: (_, key) =>
				key === "subscribeToState"
					? (_: any, cb: any) => {
							h.receive = cb.onResponse
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
