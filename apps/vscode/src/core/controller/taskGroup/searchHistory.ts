import { SearchHistoryRequest, SearchHistoryResponse } from "@shared/proto/cline/task_group"
import { Controller } from ".."
import { historySearchHitToProto } from "./conversions"

/**
 * Searches history across tasks, threads, notes and messages.
 * @param controller The controller instance
 * @param request The search request (query, kind filter, limit)
 * @returns SearchHistoryResponse with ranked results
 */
export async function searchHistory(controller: Controller, request: SearchHistoryRequest): Promise<SearchHistoryResponse> {
	const hits = await controller.searchHistory({ query: request.query, kind: request.kind, limit: request.limit })
	return SearchHistoryResponse.create({ results: hits.map(historySearchHitToProto) })
}
