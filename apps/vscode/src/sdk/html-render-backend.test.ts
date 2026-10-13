import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { CoreSessionEvent } from "@cline/core"
import type { Message as SdkMessage } from "@cline/llms"
import { afterAll, describe, expect, it, vi } from "vitest"
import { buildThemeBootstrap, heightForWidth, parseHtmlRenderRef } from "@/shared/htmlRender"
import { MessageTranslatorState, sdkMessagesToClineMessages, translateSessionEvent } from "./message-translator"

const storage = await fs.mkdtemp(path.resolve("../../tmp/html-render/cline-html-test-"))
vi.mock("@/core/storage/disk", () => ({ ensureTaskDirectoryExists: async (id: string) => path.join(storage, "tasks", id) }))
vi.mock("@/hosts/host-provider", () => ({ HostProvider: { get: () => ({ globalStorageFsPath: storage }) } }))
vi.mock("@/services/browser/utils", () => ({
	ensureChromiumExists: vi.fn(async () => ({ executablePath: process.env.HTML_RENDER_TEST_CHROME })),
}))
const { attachmentTaskId, prepareHtml, renderHtml, getHtmlRender } = await import("@/services/html-render/HtmlRenderService")
afterAll(() => fs.rm(storage, { recursive: true, force: true }))
const ref = { attachmentId: "task-1-12345678-1234-1234-1234-123456789abc-html", title: "Chart", height: 500 }

describe("HTML render backend", () => {
	it("validates references and rejects traversal", () => {
		expect(parseHtmlRenderRef(JSON.stringify({ htmlRender: ref }))).toEqual(ref)
		expect(parseHtmlRenderRef(JSON.stringify(ref))).toEqual(ref)
		for (const id of ["../secret", "/tmp/file", "task-../123-html"]) {
			expect(() => attachmentTaskId(id)).toThrow()
			expect(parseHtmlRenderRef(JSON.stringify({ ...ref, attachmentId: id }))).toBeUndefined()
		}
		expect(parseHtmlRenderRef(JSON.stringify({ ...ref, heights: [[0, 200]] }))).toBeUndefined()
	})
	it("uses taller neighboring widths and preserves an intentional scroll cap", () => {
		const measured = {
			...ref,
			heights: [
				[320, 900],
				[728, 400],
				[1000, 300],
			] as [number, number][],
		}
		expect(heightForWidth(measured, 520)).toBe(900)
		expect(heightForWidth(measured, 728)).toBe(400)
		expect(heightForWidth({ ...measured, height: 200 }, 520)).toBe(200)
		expect(heightForWidth(ref, 520)).toBe(500)
	})
	it("injects bootstrap before author scripts and inlines quoted and CSS images", async () => {
		const filename = path.join(storage, "pixel.png")
		await fs.writeFile(
			filename,
			Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=", "base64"),
		)
		const html = await prepareHtml(
			`<html><head><script>window.author=true</script></head><body><img src="${filename}"><div style='background:url(${filename})'></div></body></html>`,
		)
		expect(html.indexOf("html-render-base")).toBeLessThan(html.indexOf("window.author"))
		expect(html.match(/data:image\/png;base64/g)?.length).toBe(2)
		expect(html).not.toContain(filename)
		expect(buildThemeBootstrap()).toContain("e.source!==parent")
		await expect(prepareHtml('<img src="/missing/local.png">')).rejects.toThrow("Cannot inline")
		await expect(prepareHtml("x".repeat(512001))).rejects.toThrow()
	})
	it("persists a new attachment per call and loads without installing Chromium", async () => {
		const first = await renderHtml("task-1", "<p>Hello</p>", "Greeting", 300)
		const second = await renderHtml("task-1", "<p>Hello</p>", "Greeting", 300)
		expect(first.attachmentId).not.toBe(second.attachmentId)
		expect(first.heights).toBeUndefined()
		expect(await getHtmlRender(first.attachmentId)).toContain("<p>Hello</p>")
		const { ensureChromiumExists } = await import("@/services/browser/utils")
		expect(ensureChromiumExists).not.toHaveBeenCalled()
	})
	it("maps completed live and persisted render calls to the same special row", () => {
		const state = new MessageTranslatorState()
		const event = (payload: object) =>
			({ type: "agent_event", payload: { sessionId: "task-1", event: payload } }) as CoreSessionEvent
		translateSessionEvent(
			event({ type: "content_start", contentType: "tool", toolName: "html_render", toolCallId: "call", input: {} }),
			state,
		)
		const live = translateSessionEvent(
			event({
				type: "content_end",
				contentType: "tool",
				toolName: "html_render",
				toolCallId: "call",
				output: JSON.stringify({ htmlRender: ref }),
			}),
			state,
		)
		expect(live.messages[0].say).toBe("html_render")
		expect(JSON.parse(live.messages[0].text!)).toEqual(ref)
		const history = sdkMessagesToClineMessages([
			{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "html_render", input: {} }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call", content: JSON.stringify({ htmlRender: ref }) }],
			},
		] as SdkMessage[])
		expect(history.some((row) => row.say === "html_render" && row.text === JSON.stringify(ref))).toBe(true)
	})
})

// Opt-in real-browser smoke test. It uses an existing Chromium executable, never downloads.
it.skipIf(!process.env.HTML_RENDER_TEST_CHROME)(
	"captures PNG, measures widths, and runs sandboxed srcdoc scripts under nonce CSP",
	async () => {
		const { previewHtml } = await import("@/services/html-render/HtmlRenderService")
		const preview = await previewHtml(
			'<div style="height:4200px">Tall</div><script>console.log("author ran")</script>',
			728,
			"dark",
		)
		expect(preview.metadata.contentHeight).toBe(4200)
		expect(preview.metadata.capturedHeight).toBe(4000)
		expect(preview.metadata.console).toContain("log: author ran")
		expect(Buffer.from(preview.data, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		const rendered = await renderHtml("task-1", '<div style="height:240px">Measured</div>', "Measured", 300)
		expect(rendered.heights?.map(([w]) => w)).toEqual([320, 375, 430, 520, 640, 728, 860, 1000])
		const { launch } = await import("puppeteer-core")
		const browser = await launch({ executablePath: process.env.HTML_RENDER_TEST_CHROME, headless: true })
		try {
			const page = await browser.newPage()
			await page.setContent(
				`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-smoke'; frame-src data: blob:"><script nonce="smoke">window.host=true</script><iframe sandbox="allow-scripts allow-forms"></iframe>`,
			)
			const prepared = await prepareHtml(
				'<div style="height:240px">Frame</div><script>window.authorRan=true;try{window.parentReadable=!!parent.document}catch(e){window.parentReadable=false}</script>',
			)
			const doc = prepared
				.replace(/<script\b/gi, '<script nonce="smoke"')
				.replace(
					'<style id="html-render-base"',
					'<script nonce="smoke">window.__HTML_RENDER_THEME__={appearance:"dark",variables:{"--foreground":"rgb(1, 2, 3)"}}</script><style id="html-render-base"',
				)
			await page.evaluate((html) => {
				document.querySelector("iframe")!.srcdoc = html
			}, doc)
			await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow !== null)
			const frame = page.frames().find((frame) => frame.parentFrame())!
			await frame.waitForFunction("window.authorRan === true")
			expect(await frame.evaluate("window.parentReadable")).toBe(false)
			expect(await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--foreground"))).toBe(
				"rgb(1, 2, 3)",
			)
			await page.evaluate(() =>
				document.querySelector("iframe")!.contentWindow!.postMessage(
					{
						jsonrpc: "2.0",
						method: "ui/notifications/host-context-changed",
						params: { theme: "light", styles: { variables: { "--foreground": "rgb(4, 5, 6)" } } },
					},
					"*",
				),
			)
			await frame.waitForFunction(
				() => getComputedStyle(document.documentElement).getPropertyValue("--foreground") === "rgb(4, 5, 6)",
			)
		} finally {
			await browser.close()
		}
	},
	30000,
)
