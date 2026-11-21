import type { HistoryItem } from "@shared/HistoryItem"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { useSyncExternalStore } from "react"
import { expect, it, vi } from "vitest"
import { historyPatchesVersion, observeHistory, patchHistoryItem, subscribeHistoryPatches } from "./optimisticHistory"
import { setTasksSettled, toggleTaskSettled } from "./sessionActions"

const mocks = vi.hoisted(() => ({ settle: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { toggleTaskSettled: (request: unknown) => mocks.settle(request) },
}))
const item = (id: string): HistoryItem => ({ id, task: id, ts: 1, tokensIn: 0, tokensOut: 0, totalCost: 0, isSettled: false })

it("renders 1, 3, 5 and 10 settled threads immediately while the RPC is still pending, then rolls back errors", async () => {
	const rows: object[] = []
	for (const count of [1, 3, 5, 10]) {
		let reject!: (error: Error) => void
		mocks.settle.mockImplementationOnce(
			() =>
				new Promise((_, fail) => {
					reject = fail
				}),
		)
		const history = Array.from({ length: 500 }, (_, i) => item(`thread-${i}`))
		observeHistory(history)
		let request: Promise<void>
		const Probe = () => {
			useSyncExternalStore(subscribeHistoryPatches, historyPatchesVersion)
			return (
				<>
					<button
						onClick={() => {
							request = setTasksSettled(
								history.slice(0, count).map((thread) => thread.id),
								true,
							)
							void request.catch(() => {})
						}}>
						Settle
					</button>
					<output>{history.map(patchHistoryItem).filter((thread) => thread.isSettled).length}</output>
				</>
			)
		}
		const view = render(<Probe />)
		const start = performance.now()
		fireEvent.click(screen.getByRole("button", { name: "Settle" }))
		expect(screen.getByRole("status")).toHaveTextContent(String(count))
		rows.push({ threads: count, clickToSettledDomMs: +(performance.now() - start).toFixed(2) })
		await act(async () => {
			reject(new Error("write failed"))
			await expect(request).rejects.toThrow("write failed")
		})
		expect(screen.getByRole("status")).toHaveTextContent("0")
		view.unmount()
	}
	console.table(rows)
})

it("freezes overlapping toggle values across stale and intermediate host snapshots", async () => {
	const history = [item("one")]
	observeHistory(history)
	let first!: () => void, second!: () => void
	mocks.settle.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				first = resolve
			}),
	)
	mocks.settle.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				second = resolve
			}),
	)
	const one = toggleTaskSettled("one")
	expect(patchHistoryItem(history[0]).isSettled).toBe(true)
	const two = toggleTaskSettled("one")
	expect(patchHistoryItem(history[0]).isSettled).toBe(false)
	observeHistory([{ ...history[0], isSettled: true }])
	first()
	await one
	expect(patchHistoryItem({ ...history[0], isSettled: true }).isSettled).toBe(false)
	second()
	await two
})
