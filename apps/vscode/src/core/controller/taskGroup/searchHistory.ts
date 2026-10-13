import { SearchHistoryRequest, SearchHistoryResponse } from "@shared/proto/cline/task_group"
import { Controller } from ".."

/**
 * Searches history across tasks, threads, notes and messages.
 * @param _controller The controller instance
 * @param _request The search request (query, kind filter, limit)
 * @returns SearchHistoryResponse with ranked results
 */
export async function searchHistory(_controller: Controller, _request: SearchHistoryRequest): Promise<SearchHistoryResponse> {
	// TODO(phase 6): implement ranked search — task titles/tags, thread titles
	// and first messages, note names/descriptions, and a scan of
	// ~/.cline/data/sessions/<id>/<id>.messages.json for message bodies.
	return SearchHistoryResponse.create({ results: [] })
}
