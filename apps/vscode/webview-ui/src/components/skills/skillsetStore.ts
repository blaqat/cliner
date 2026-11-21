import type { SkillsetImportResult } from "@shared/skillsets"
import { useSyncExternalStore } from "react"
import { openTopBarPanel } from "@/components/topbar/topBarPanels"
import type { EatPhase } from "./EatingLogo"

// One small store for the skillset moment: the logo's phase while a set is
// dragged in, the toasts that follow, and the request that opens the Skills
// tab with the new items marked. Module state, like topBarPanels, because the
// drop layer, the home logo, the toasts and the Rules overlay live far apart.

export interface SkillsetToast {
	id: number
	result: SkillsetImportResult
}

export type RulesTab = "rules" | "hooks" | "skills" | "workflows" | "automations"

export interface SkillsRequest {
	tab: RulesTab
	/** Open the Share page in the Skills tab. */
	share?: boolean
	/** Mark this set's items as new (the toast's View). */
	setId?: string
}

interface State {
	phase: EatPhase
	toasts: SkillsetToast[]
	request: SkillsRequest | null
	/** Home or new-chat logos on screen: the veil puts its logo where they are. */
	anchors: number
}

let state: State = { phase: "idle", toasts: [], request: null, anchors: 0 }
const listeners = new Set<() => void>()
const anchorElements = new Set<HTMLElement>()
let toastId = 0

function set(next: Partial<State>): void {
	state = { ...state, ...next }
	for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function useSkillsetState<T>(select: (state: State) => T): T {
	return useSyncExternalStore(subscribe, () => select(state))
}

export function getSkillsetState(): State {
	return state
}

export function setEatPhase(phase: EatPhase): void {
	if (state.phase !== phase) set({ phase })
}

/** A home or new-chat logo registers itself so the veil's logo can sit right on top of it. */
export function registerLogoAnchor(element: HTMLElement): () => void {
	anchorElements.add(element)
	set({ anchors: anchorElements.size })
	return () => {
		anchorElements.delete(element)
		set({ anchors: anchorElements.size })
	}
}

/** The on-screen rectangle of a registered logo, if one is visible. */
export function visibleLogoAnchor(): DOMRect | undefined {
	for (const element of anchorElements) {
		const rect = element.getBoundingClientRect()
		if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) return rect
	}
	return undefined
}

export function addSkillsetToast(result: SkillsetImportResult): void {
	set({ toasts: [{ id: ++toastId, result }, ...state.toasts].slice(0, 3) })
}

export function dismissSkillsetToast(id: number): void {
	set({ toasts: state.toasts.filter((toast) => toast.id !== id) })
}

/** Opens Rules & workflows on a tab (the toast's View, Share…, What's a skillset?). */
export function openSkills(request: SkillsRequest): void {
	set({ request })
	openTopBarPanel("rules")
}

/** The Rules overlay takes the request once, when it opens or while it's open. */
export function takeSkillsRequest(): SkillsRequest | null {
	const request = state.request
	if (request) set({ request: null })
	return request
}
