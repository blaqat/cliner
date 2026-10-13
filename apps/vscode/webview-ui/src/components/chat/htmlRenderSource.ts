import { GetHtmlRenderRequest } from "@shared/proto/cline/file"
import { FileServiceClient } from "@/services/grpc-client"

/** Loads a stored `html_render` page (theme bootstrap already injected) by attachment id. */
export async function fetchHtmlRender(attachmentId: string): Promise<string> {
	const response = await FileServiceClient.getHtmlRender(GetHtmlRenderRequest.create({ attachmentId }))
	return response.html
}
