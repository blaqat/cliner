import type { AgentTool } from "@cline/shared"
import { HTML_MAX_CHARS, previewHtml, renderHtml } from "@/services/html-render/HtmlRenderService"
import { HTML_PREVIEW_TOOL, HTML_RENDER_TOOL } from "@/shared/htmlRender"

const guidance =
	"Use self-contained HTML with inline CSS and JavaScript. Theme variables: --background, --foreground, --muted, --muted-foreground, --card, --border, --accent, --accent-foreground, --primary, --chart-1 through --chart-5, --font-sans, --font-mono. Use fluid content without a page-wide background or outer card. Never use 100vh; give charts fixed pixel heights. Absolute local image paths are inlined. Call html_preview before html_render, then html_render before your final answer."
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
			name: HTML_PREVIEW_TOOL,
			description: `Inspect a headless Chromium screenshot and console diagnostics before publishing HTML. ${guidance}`,
			inputSchema: {
				type: "object",
				properties: {
					html: { type: "string", maxLength: HTML_MAX_CHARS },
					width: { type: "number", minimum: 240, maximum: 1600, default: 728 },
					appearance: { type: "string", enum: ["dark", "light"], default: "dark" },
				},
				required: ["html"],
				additionalProperties: false,
			},
			timeoutMs: 21_000,
			retryable: false,
			metadata: { readOnlyHint: true, idempotentHint: true },
			async execute(value, context) {
				const request = input(value)
				if (request.appearance !== undefined && request.appearance !== "dark" && request.appearance !== "light")
					throw new Error("appearance must be dark or light")
				const result = await previewHtml(
					html(request.html),
					dimension(request.width, 728, 240, 1600),
					request.appearance === "light" ? "light" : "dark",
					context.signal,
				)
				if (context.metadata?.modelSupportsImages !== true)
					return [
						{
							type: "text",
							text: JSON.stringify({ ...result.metadata, error: "Current model does not support image input" }),
						},
					]
				return [
					{ type: "text", text: JSON.stringify(result.metadata) },
					{ type: "image", data: result.data, mediaType: "image/png" },
				]
			},
		},
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
