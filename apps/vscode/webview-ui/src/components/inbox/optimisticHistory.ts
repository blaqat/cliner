import type { HistoryItem } from "@shared/HistoryItem"

// Pending field patches survive stale streaming snapshots and overlap independently.
const pending = new Map<symbol, Map<string, Partial<HistoryItem>>>()
const listeners = new Set<() => void>()
let source = new Map<string, HistoryItem>()
let version = 0
function emit() {
	version++
	for (const listener of listeners) listener()
}
export const subscribeHistoryPatches = (listener: () => void) => {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
export const historyPatchesVersion = () => version
export function observeHistory(items: HistoryItem[]): void {
	source = new Map(items.map((item) => [item.id, item]))
}
export function patchHistoryItem(item: HistoryItem): HistoryItem {
	let result = item
	for (const patches of pending.values()) {
		const patch = patches.get(item.id)
		if (patch) result = { ...result, ...patch }
	}
	return result
}
export function beginHistoryPatch(ids: string[], patch: (item: HistoryItem) => Partial<HistoryItem>): () => void {
	const key = Symbol()
	const patches = new Map<string, Partial<HistoryItem>>()
	for (const id of ids) {
		const item = source.get(id)
		if (item) patches.set(id, patch(patchHistoryItem(item)))
	}
	pending.set(key, patches)
	emit()
	return () => {
		pending.delete(key)
		emit()
	}
}
