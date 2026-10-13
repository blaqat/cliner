import type { GetHtmlRenderRequest, GetHtmlRenderResponse } from "@shared/proto/cline/file"
import { getHtmlRender as loadHtmlRender } from "@/services/html-render/HtmlRenderService"
import type { Controller } from ".."
export async function getHtmlRender(_controller: Controller, request: GetHtmlRenderRequest): Promise<GetHtmlRenderResponse> {
	return { html: await loadHtmlRender(request.attachmentId) }
}
