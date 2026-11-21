import { useSyncExternalStore } from "react"

/**
 * What the webview shows beside the thread on screen, per main thread: the side thread
 * open in the column beside it (wide only) and the side question card above the composer.
 * Session-only: reopening a thread shows the panel again, and a side question that
 * wasn't kept or closed is still listed under Main in the panel.
 */
export interface SideThreadSlots {
	/** Main thread id → the side thread shown in the column beside it. */
	beside: Readonly<Record<string, string>>
	/** Thread id → its open side question. */
	question: Readonly<Record<string, string>>
	/** Side thread id → Wrap up was asked; the card shows the answer as a draft once it lands. */
	wrapUp: Readonly<Record<string, true>>
	/** There's room for a side thread's column beside Main (wide). */
	room: boolean
}

let slots: SideThreadSlots = { beside: {}, question: {}, wrapUp: {}, room: false }
const listeners = new Set<() => void>()

function update(next: Partial<SideThreadSlots>): void {
	slots = { ...slots, ...next }
	for (const listener of listeners) listener()
}

function without(map: Readonly<Record<string, string>>, key: string): Record<string, string> {
	const { [key]: _removed, ...rest } = map
	return rest
}

export function getSideThreadSlots(): SideThreadSlots {
	return slots
}

export function useSideThreadSlots(): SideThreadSlots {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		() => slots,
	)
}

export function setPanelRoom(room: boolean): void {
	if (slots.room !== room) update({ room })
}

export function showBeside(mainId: string, sideId: string): void {
	update({ beside: { ...slots.beside, [mainId]: sideId } })
}

/** Hides the side thread beside Main; it keeps going and stays listed in the panel. */
export function clearBeside(mainId: string): void {
	if (slots.beside[mainId]) update({ beside: without(slots.beside, mainId) })
}

export function showQuestion(threadId: string, questionId: string): void {
	update({ question: { ...slots.question, [threadId]: questionId } })
}

export function clearQuestion(threadId: string): void {
	if (slots.question[threadId]) update({ question: without(slots.question, threadId) })
}

export function markWrapUp(sideId: string, asked: boolean): void {
	if (!!slots.wrapUp[sideId] === asked) return
	const { [sideId]: _removed, ...rest } = slots.wrapUp
	update({ wrapUp: asked ? { ...rest, [sideId]: true } : rest })
}

/** Forgets a side thread everywhere it's shown (closed or deleted). */
export function forgetSideThread(sideId: string): void {
	const drop = (map: Readonly<Record<string, string>>) =>
		Object.fromEntries(Object.entries(map).filter(([, value]) => value !== sideId))
	const { [sideId]: _removed, ...wrapUp } = slots.wrapUp
	update({ beside: drop(slots.beside), question: drop(slots.question), wrapUp })
}

/** Tests only. */
export function resetSideThreadSlots(): void {
	slots = { beside: {}, question: {}, wrapUp: {}, room: false }
	for (const listener of listeners) listener()
}
