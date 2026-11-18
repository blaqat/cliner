import { Empty, type StringArrayRequest } from "@shared/proto/cline/common"
import type { Controller } from ".."

/** The side threads shown beside Main; an empty list stops watching. */
export async function watchSideThreads(controller: Controller, request: StringArrayRequest): Promise<Empty> {
	controller.watchSideThreads(request.value)
	return Empty.create({})
}
