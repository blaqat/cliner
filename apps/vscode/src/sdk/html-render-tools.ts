import type { AgentTool } from "@cline/shared"
import { HTML_MAX_CHARS, renderHtml } from "@/services/html-render/HtmlRenderService"
import { HTML_RENDER_TOOL } from "@/shared/htmlRender"

const guidance =
	"Use self-contained HTML with inline CSS and JavaScript. Theme variables: --background, --foreground, --muted, --muted-foreground, --card, --border, --accent, --accent-foreground, --primary, --chart-1 through --chart-5, --font-sans, --font-mono. Use fluid content without a page-wide background or outer card. Never use 100vh; give charts fixed pixel heights. Absolute local image paths are inlined. Pick height to fit the content (it is a cap; taller content scrolls inside the frame). Call html_render before your final answer. Inline on* handlers work; fetch() and other network requests from the page are blocked."
function input(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
	return value as Record<string, unknown>
}
function html(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > HTML_MAX_CHARS)
		throw new Error(`html must contain 1-${HTML_MAX_CHARS} characters`)
	return value
}
function dimension(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite numeric dimension")
	return Math.max(min, Math.min(max, Math.round(value)))
}
export function createHtmlRenderTools(): AgentTool[] {
	return [
		{
			name: HTML_RENDER_TOOL,
			description: `Publish an interactive HTML page above your reply. Each call creates a new attachment; this is non-idempotent. ${guidance} The page is shown to the reader; do not announce or restate it in your final answer.`,
			inputSchema: {
				type: "object",
				properties: {
					html: { type: "string", maxLength: HTML_MAX_CHARS },
					title: { type: "string", minLength: 1, maxLength: 200 },
					height: { type: "number", minimum: 80, maximum: 2000 },
				},
				required: ["html", "title", "height"],
				additionalProperties: false,
			},
			retryable: false,
			metadata: { readOnlyHint: false, idempotentHint: false },
			async execute(value, context) {
				const request = input(value)
				if (typeof request.title !== "string" || !request.title.trim() || request.title.length > 200)
					throw new Error("title must contain 1-200 characters")
				if (request.height === undefined) throw new Error("height is required")
				if (!context.sessionId) throw new Error("HTML render requires an active task")
				const ref = await renderHtml(
					context.sessionId,
					html(request.html),
					request.title,
					dimension(request.height, 520, 80, 2000),
				)
				return JSON.stringify({
					htmlRender: ref,
					message: "Shown to the reader above your reply. Do not restate or announce it; add only what it doesn't say.",
				})
			},
		},
	]
}
