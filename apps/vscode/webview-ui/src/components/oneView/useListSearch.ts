import { useEffect, useMemo, useRef, useState } from "react"
import { fetchServerRows, SEARCH_DEBOUNCE_MS } from "@/components/search/SearchView"
import { mergeResults, type SearchRow, searchLocal } from "@/components/search/searchUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { type ListSearchMatches, mapSearchRows } from "./threadListModel"

export interface ListSearch {
	/** The field has text: the list shows only matches. */
	active: boolean
	matches: ListSearchMatches
	/** Waiting on the host's note and message hits. */
	searching: boolean
}

/**
 * The search view's backend, for filtering the list in place: titles and tags are matched
 * locally right away; note and message text comes from the host, debounced, with stale
 * responses dropped (same sources and ranking as the search page).
 */
export function useListSearch(query: string): ListSearch {
	const { taskHistory, taskGroups } = useExtensionState()
	const [server, setServer] = useState<{ query: string; rows: SearchRow[] }>({ query: "", rows: [] })
	const [searching, setSearching] = useState(false)
	const requestRef = useRef(0)
	const trimmed = query.trim()

	useEffect(() => {
		const request = ++requestRef.current
		if (!trimmed) {
			setServer({ query: "", rows: [] })
			setSearching(false)
			return
		}
		setSearching(true)
		const timer = setTimeout(() => {
			void fetchServerRows(trimmed).then((rows) => {
				if (request !== requestRef.current) return
				setServer({ query: trimmed, rows })
				setSearching(false)
			})
		}, SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [trimmed])

	const history = taskHistory ?? []
	const groups = taskGroups ?? []
	const local = useMemo(() => searchLocal(trimmed, groups, history), [trimmed, groups, history])
	const matches = useMemo(
		() => mapSearchRows(mergeResults(local, trimmed && server.query === trimmed ? server.rows : []), history),
		[local, server, trimmed, history],
	)
	return { active: !!trimmed, matches, searching }
}
