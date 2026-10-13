import { describe, expect, it, vi } from "vitest"
import { createHtmlRenderTools } from "./html-render-tools"

const mocks = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock("@/services/html-render/HtmlRenderService", () => ({
	renderHtml: mocks.render,
	HTML_MAX_CHARS: 512000,
}))
const context = { agentId: "agent", iteration: 1, sessionId: "task", metadata: { modelSupportsImages: true } }
describe("HTML tools", () => {
	it("validates inputs and returns a non-idempotent render reference", async () => {
		const tools = createHtmlRenderTools()
		expect(tools.map((tool) => tool.name)).toEqual(["html_render"])
		await expect(
			tools[0].execute({ html: "x", title: "Title", height: 300 }, { ...context, sessionId: undefined }),
		).rejects.toThrow("active task")
		await expect(tools[0].execute({ html: "x", title: "Title" }, context)).rejects.toThrow("height is required")
		const ref = { attachmentId: "task-12345678-1234-1234-1234-123456789abc-html", title: "Title", height: 2000 }
		mocks.render.mockResolvedValue(ref)
		const result = (await tools[0].execute({ html: "x", title: "Title", height: 9000 }, context)) as string
		expect(JSON.parse(result).htmlRender).toEqual(ref)
		expect(mocks.render).toHaveBeenCalledWith("task", "x", "Title", 2000)
		expect(tools[0].retryable).toBe(false)
		expect(tools[0].metadata?.idempotentHint).toBe(false)
	})
})
