import { describe, expect, it, vi } from "vitest"
import { createHtmlRenderTools } from "./html-render-tools"

const mocks = vi.hoisted(() => ({ preview: vi.fn(), render: vi.fn() }))
vi.mock("@/services/html-render/HtmlRenderService", () => ({
	previewHtml: mocks.preview,
	renderHtml: mocks.render,
	HTML_MAX_CHARS: 512000,
}))
const context = { agentId: "agent", iteration: 1, sessionId: "task", metadata: { modelSupportsImages: true } }
describe("HTML tools", () => {
	it("returns screenshot separately from text metadata, with defaults", async () => {
		const metadata = {
			width: 728,
			contentHeight: 300,
			capturedHeight: 300,
			console: [],
			screenshot: { width: 728, height: 300, mimeType: "image/png" },
		}
		mocks.preview.mockResolvedValue({ data: "png-base64", metadata })
		const tools = createHtmlRenderTools()
		expect(await tools[0].execute({ html: "<p>test</p>" }, context)).toEqual([
			{ type: "text", text: JSON.stringify(metadata) },
			{ type: "image", data: "png-base64", mediaType: "image/png" },
		])
		expect(mocks.preview).toHaveBeenCalledWith("<p>test</p>", 728, "dark", undefined)
		const unsupported = (await tools[0].execute(
			{ html: "<p>test</p>" },
			{ ...context, metadata: { modelSupportsImages: false } },
		)) as { type: string; text: string }[]
		expect(unsupported).toHaveLength(1)
		expect(JSON.parse(unsupported[0].text).error).toContain("does not support")
		expect(unsupported[0].text).not.toContain("png-base64")
	})
	it("validates inputs and returns a non-idempotent render reference", async () => {
		const tools = createHtmlRenderTools()
		await expect(tools[0].execute({ html: "x", appearance: "invalid" }, context)).rejects.toThrow()
		await expect(
			tools[1].execute({ html: "x", title: "Title", height: 300 }, { ...context, sessionId: undefined }),
		).rejects.toThrow("active task")
		await expect(tools[1].execute({ html: "x", title: "Title" }, context)).rejects.toThrow("height is required")
		const ref = { attachmentId: "task-12345678-1234-1234-1234-123456789abc-html", title: "Title", height: 2000 }
		mocks.render.mockResolvedValue(ref)
		const result = (await tools[1].execute({ html: "x", title: "Title", height: 9000 }, context)) as string
		expect(JSON.parse(result).htmlRender).toEqual(ref)
		expect(mocks.render).toHaveBeenCalledWith("task", "x", "Title", 2000)
		expect(tools[1].retryable).toBe(false)
		expect(tools[1].metadata?.idempotentHint).toBe(false)
	})
})
