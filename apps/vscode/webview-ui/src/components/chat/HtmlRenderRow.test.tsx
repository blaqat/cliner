import { HTML_RENDER_THEME_VARS, type HtmlRenderRef, heightForWidth } from "@shared/htmlRender"
import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HtmlRenderRow, htmlRenderFrameCap, prepareHtmlRenderDocument } from "./HtmlRenderRow"
import { readHtmlRenderTheme } from "./htmlRenderTheme"

const openUrl = vi.fn((_request: unknown) => Promise.resolve({}))

vi.mock("@/services/grpc-client", () => ({
	UiServiceClient: { openUrl: (request: unknown) => openUrl(request) },
	FileServiceClient: { getHtmlRender: vi.fn() },
}))

const BOOTSTRAP = '<style id="html-render-base">:root{}</style><script>/* bootstrap */</script>'
const PAGE = `<!doctype html><html><head>${BOOTSTRAP}</head><body><div id="chart"></div><script src="https://cdn.example/x.js"></script></body></html>`

const ref: HtmlRenderRef = {
	attachmentId: "task-1-00000000-0000-0000-0000-000000000000-html",
	title: "Quarterly results",
	height: 520,
	heights: [
		[320, 900],
		[728, 400],
		[1000, 380],
	],
}

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

function renderRow(htmlRef: HtmlRenderRef = ref, loadHtml = vi.fn(() => Promise.resolve(PAGE))) {
	const utils = render(<HtmlRenderRow htmlRef={htmlRef} loadHtml={loadHtml} />)
	return { ...utils, loadHtml }
}

function frameBox(): HTMLElement {
	return screen.getByTestId("html-render-row").lastElementChild as HTMLElement
}

async function readyFrame(): Promise<HTMLIFrameElement> {
	return await waitFor(() => {
		const iframe = document.querySelector("iframe")
		expect(iframe).not.toBeNull()
		return iframe as HTMLIFrameElement
	})
}

function postFromFrame(data: unknown, source: Window | null) {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data, source }))
	})
}

describe("HtmlRenderRow", () => {
	beforeEach(() => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub)
		openUrl.mockClear()
		document.body.setAttribute("data-vscode-theme-kind", "vscode-dark")
		document.documentElement.style.setProperty("--vscode-foreground", "#abcdef")
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		document.body.removeAttribute("data-vscode-theme-kind")
		document.documentElement.removeAttribute("style")
	})

	it("loads the page into an opaque-origin sandboxed iframe", async () => {
		const { loadHtml } = renderRow()
		expect(screen.getByText("Loading…")).toBeInTheDocument()
		expect(loadHtml).toHaveBeenCalledWith(ref.attachmentId)

		const iframe = await readyFrame()
		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
		expect(iframe.getAttribute("srcdoc")).toContain("window.__HTML_RENDER_THEME__=")
		expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
	})

	it("reserves the measured height for the column width before the page reports", async () => {
		renderRow()
		await readyFrame()
		// jsdom has no layout, so the default 728px column is used.
		expect(frameBox().style.height).toBe(`${heightForWidth(ref, 728)}px`)
	})

	it("follows size-changed messages from its own frame, within the cap", async () => {
		renderRow()
		const iframe = await readyFrame()
		const size = (height: number) => ({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } })

		postFromFrame(size(612.4), iframe.contentWindow)
		expect(frameBox().style.height).toBe("613px")

		postFromFrame(size(5000), iframe.contentWindow)
		expect(frameBox().style.height).toBe("2000px")

		// Another window (or the webview itself) cannot resize the frame.
		postFromFrame(size(300), window)
		expect(frameBox().style.height).toBe("2000px")
	})

	it("keeps the requested height as a scroll cap when it is below the content height", async () => {
		renderRow({ ...ref, height: 200 })
		const iframe = await readyFrame()
		expect(frameBox().style.height).toBe("200px")

		postFromFrame({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 400 } }, iframe.contentWindow)
		expect(frameBox().style.height).toBe("200px")
	})

	it("opens http(s) links requested by the frame and answers the request", async () => {
		renderRow()
		const iframe = await readyFrame()
		const reply = vi.spyOn(iframe.contentWindow as Window, "postMessage")

		postFromFrame(
			{ jsonrpc: "2.0", id: "t3-link-1", method: "ui/open-link", params: { url: "https://example.com/a" } },
			iframe.contentWindow,
		)
		expect(openUrl).toHaveBeenCalledWith(expect.objectContaining({ value: "https://example.com/a" }))
		expect(reply).toHaveBeenCalledWith({ jsonrpc: "2.0", id: "t3-link-1", result: {} }, "*")

		postFromFrame(
			{ jsonrpc: "2.0", id: "t3-link-2", method: "ui/open-link", params: { url: "javascript:alert(1)" } },
			iframe.contentWindow,
		)
		postFromFrame(
			{ jsonrpc: "2.0", id: "t3-link-3", method: "ui/open-link", params: { url: "https://evil.example" } },
			window,
		)
		expect(openUrl).toHaveBeenCalledTimes(1)
	})

	it("posts theme changes into the live page", async () => {
		renderRow()
		const iframe = await readyFrame()
		const post = vi.spyOn(iframe.contentWindow as Window, "postMessage")

		document.body.setAttribute("data-vscode-theme-kind", "vscode-light")
		document.documentElement.style.setProperty("--vscode-foreground", "#111111")

		await waitFor(() =>
			expect(post).toHaveBeenCalledWith(
				expect.objectContaining({
					method: "ui/notifications/host-context-changed",
					params: expect.objectContaining({
						theme: "light",
						styles: { variables: expect.objectContaining({ "--foreground": "#111111" }) },
					}),
				}),
				"*",
			),
		)
	})

	it("shows an error instead of the frame when the page cannot be loaded", async () => {
		renderRow(
			ref,
			vi.fn(() => Promise.reject(new Error("missing page"))),
		)
		expect(await screen.findByRole("alert")).toHaveTextContent("missing page")
		expect(document.querySelector("iframe")).toBeNull()
		expect(frameBox().style.height).toBe("")
	})
})

describe("prepareHtmlRenderDocument", () => {
	const theme = { appearance: "dark" as const, variables: { "--foreground": "</script><b>" } }

	it("stamps the webview nonce on every script and defines the theme before the bootstrap", () => {
		const doc = prepareHtmlRenderDocument(PAGE, theme, "n0nce")
		expect(doc.match(/<script nonce="n0nce"/g)).toHaveLength(3)
		expect(doc).not.toMatch(/<script(?![^>]*nonce)/)
		expect(doc.indexOf("__HTML_RENDER_THEME__")).toBeLessThan(doc.indexOf('<style id="html-render-base"'))
		// Theme values cannot close the inline script.
		expect(doc).not.toContain("</script><b>")
	})

	it("falls back to the head, then the document start, without a bootstrap", () => {
		expect(prepareHtmlRenderDocument("<html><head><title>x</title></head></html>", theme, undefined)).toMatch(
			/^<html><head><script>window.__HTML_RENDER_THEME__=/,
		)
		expect(prepareHtmlRenderDocument("<p>hi</p>", theme, undefined)).toMatch(
			/^<script>window.__HTML_RENDER_THEME__=.*<p>hi<\/p>$/,
		)
	})
})

describe("htmlRenderFrameCap", () => {
	it("lets the frame grow when the requested height covers the 728px measurement", () => {
		expect(htmlRenderFrameCap(ref)).toBe(2000)
	})

	it("keeps the requested height without samples or when it is a scroll cap", () => {
		expect(htmlRenderFrameCap({ ...ref, heights: undefined })).toBe(520)
		expect(htmlRenderFrameCap({ ...ref, height: 300 })).toBe(300)
	})
})

describe("readHtmlRenderTheme", () => {
	afterEach(() => {
		document.body.removeAttribute("data-vscode-theme-kind")
		document.body.className = ""
		document.documentElement.removeAttribute("style")
	})

	it("maps VS Code colors and fonts to the page variables", () => {
		document.body.setAttribute("data-vscode-theme-kind", "vscode-high-contrast-light")
		document.documentElement.style.setProperty("--vscode-sideBar-background", "#fafafa")
		document.documentElement.style.setProperty("--vscode-charts-blue", "#0000ff")
		document.documentElement.style.setProperty("--vscode-font-family", "Inter")

		const theme = readHtmlRenderTheme()
		expect(theme.appearance).toBe("light")
		expect(theme.variables["--background"]).toBe("#fafafa")
		expect(theme.variables["--chart-1"]).toBe("#0000ff")
		expect(theme.variables["--font-sans"]).toMatch(/^Inter, /)
	})

	it("uses appearance defaults for colors the host does not define", () => {
		document.body.className = "vscode-dark"
		const theme = readHtmlRenderTheme()
		expect(theme.appearance).toBe("dark")
		expect(theme.variables["--foreground"]).toBe("#cccccc")
		expect(Object.keys(theme.variables).sort()).toEqual([...HTML_RENDER_THEME_VARS].sort())
	})
})
