import { type HtmlRenderRef, heightForWidth } from "@shared/htmlRender"
import { StringRequest } from "@shared/proto/cline/common"
import { CircleXIcon, LoaderCircleIcon } from "lucide-react"
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { UiServiceClient } from "@/services/grpc-client"
import { fetchHtmlRender } from "./htmlRenderSource"
import { type HtmlRenderTheme, useHtmlRenderTheme } from "./htmlRenderTheme"

/** Width the agent's requested height and the server's baseline sample refer to. */
const DEFAULT_COLUMN_WIDTH = 728
const MAX_FRAME_HEIGHT = 2000
const MIN_FRAME_HEIGHT = 16

/**
 * Upper bound for the live content height. A requested height below the
 * content measured at the default column width is a scroll cap; otherwise
 * the frame may grow (narrow columns wrap taller) up to the global maximum.
 */
export function htmlRenderFrameCap(ref: HtmlRenderRef): number {
	const baseline = ref.heights?.find(([width]) => width === DEFAULT_COLUMN_WIDTH)?.[1]
	return baseline !== undefined && ref.height >= baseline ? MAX_FRAME_HEIGHT : ref.height
}

/** The webview's script nonce; inline scripts in the frame inherit the webview CSP. */
function webviewScriptNonce(): string | undefined {
	return document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined
}

function escapeForInlineScript(json: string): string {
	return json
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029")
}

/**
 * Prepares the stored page for `srcdoc`. An about:srcdoc document inherits the
 * webview's CSP (`script-src 'nonce-…'`), so every `<script>` gets the
 * webview nonce or it would never run. The initial theme is defined ahead of
 * the injected bootstrap so the first paint already uses the reader's colors.
 */
export function prepareHtmlRenderDocument(html: string, theme: HtmlRenderTheme, nonce: string | undefined): string {
	const nonceAttr = nonce ? ` nonce="${nonce}"` : ""
	const stamped = nonce ? html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script${nonceAttr}`) : html
	const themeScript = `<script${nonceAttr}>window.__HTML_RENDER_THEME__=${escapeForInlineScript(JSON.stringify(theme))};</script>`
	const bootstrapIndex = stamped.indexOf('<style id="html-render-base"')
	if (bootstrapIndex >= 0) {
		return stamped.slice(0, bootstrapIndex) + themeScript + stamped.slice(bootstrapIndex)
	}
	const head = /<head\b[^>]*>/i.exec(stamped)
	if (head) {
		const end = head.index + head[0].length
		return stamped.slice(0, end) + themeScript + stamped.slice(end)
	}
	return themeScript + stamped
}

type FrameMessage =
	| { jsonrpc: "2.0"; method: "ui/notifications/size-changed"; params: { height: number } }
	| { jsonrpc: "2.0"; id: string | number; method: "ui/open-link"; params: { url: string } }

function asFrameMessage(data: unknown): FrameMessage | undefined {
	if (!data || typeof data !== "object") {
		return undefined
	}
	const message = data as { jsonrpc?: unknown; method?: unknown; params?: unknown }
	if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || !message.params) {
		return undefined
	}
	return message as FrameMessage
}

function isWebUrl(value: unknown): value is string {
	if (typeof value !== "string") {
		return false
	}
	try {
		const url = new URL(value)
		return url.protocol === "http:" || url.protocol === "https:"
	} catch {
		return false
	}
}

interface HtmlRenderRowProps {
	htmlRef: HtmlRenderRef
	/** Overrides how the page is fetched (tests). */
	loadHtml?: (attachmentId: string) => Promise<string>
}

type LoadState = { status: "loading" } | { status: "ready"; html: string } | { status: "error"; error: string }

/**
 * Agent-authored HTML page (the `html_render` tool), shown inline in a
 * sandboxed, opaque-origin iframe. Borderless and transparent so it reads as
 * part of the reply, following the chat column width.
 */
export const HtmlRenderRow = memo(({ htmlRef, loadHtml = fetchHtmlRender }: HtmlRenderRowProps) => {
	const { attachmentId, title } = htmlRef
	const theme = useHtmlRenderTheme()
	const containerRef = useRef<HTMLDivElement>(null)
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const [width, setWidth] = useState(DEFAULT_COLUMN_WIDTH)
	const [contentHeight, setContentHeight] = useState<number>()
	const [state, setState] = useState<LoadState>({ status: "loading" })

	useEffect(() => {
		let cancelled = false
		setState({ status: "loading" })
		setContentHeight(undefined)
		loadHtml(attachmentId)
			.then((html) => {
				if (!cancelled) {
					setState({ status: "ready", html })
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setState({ status: "error", error: error instanceof Error ? error.message : String(error) })
				}
			})
		return () => {
			cancelled = true
		}
	}, [attachmentId, loadHtml])

	useLayoutEffect(() => {
		const element = containerRef.current
		if (!element) {
			return
		}
		const measure = () => {
			if (element.clientWidth > 0) {
				setWidth(element.clientWidth)
			}
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	// The srcdoc is built once per load with the theme at that moment; later
	// theme changes are posted into the live page instead of reloading it.
	const themeRef = useRef(theme)
	themeRef.current = theme
	const srcDoc = useMemo(
		() =>
			state.status === "ready" ? prepareHtmlRenderDocument(state.html, themeRef.current, webviewScriptNonce()) : undefined,
		[state],
	)

	const postTheme = useCallback((next: HtmlRenderTheme) => {
		iframeRef.current?.contentWindow?.postMessage(
			{
				jsonrpc: "2.0",
				method: "ui/notifications/host-context-changed",
				params: { theme: next.appearance, styles: { variables: next.variables } },
			},
			"*",
		)
	}, [])

	useEffect(() => {
		postTheme(theme)
	}, [theme, postTheme])

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const frameWindow = iframeRef.current?.contentWindow
			if (!frameWindow || event.source !== frameWindow) {
				return
			}
			const message = asFrameMessage(event.data)
			if (!message) {
				return
			}
			if (message.method === "ui/notifications/size-changed") {
				const height = Number(message.params.height)
				if (Number.isFinite(height) && height >= 0) {
					setContentHeight(Math.ceil(height))
				}
				return
			}
			if (message.method === "ui/open-link" && isWebUrl(message.params.url)) {
				UiServiceClient.openUrl(StringRequest.create({ value: message.params.url })).catch((error) =>
					console.error("Failed to open link from HTML render:", error),
				)
				frameWindow.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*")
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

	const cap = htmlRenderFrameCap(htmlRef)
	const frameHeight =
		contentHeight !== undefined ? Math.max(MIN_FRAME_HEIGHT, Math.min(cap, contentHeight)) : heightForWidth(htmlRef, width)

	return (
		<div className="flex flex-col gap-1" data-testid="html-render-row">
			<div className="truncate text-xs text-description" title={title}>
				{title}
			</div>
			<div
				className="relative w-full"
				ref={containerRef}
				style={state.status === "error" ? undefined : { height: frameHeight }}>
				{srcDoc !== undefined && (
					<iframe
						className="block size-full border-0 bg-transparent"
						data-attachment-id={attachmentId}
						onLoad={() => postTheme(themeRef.current)}
						ref={iframeRef}
						sandbox="allow-scripts allow-forms"
						srcDoc={srcDoc}
						title={title}
					/>
				)}
				{state.status === "loading" && (
					<div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-description">
						<LoaderCircleIcon className="size-3 animate-spin" />
						Loading…
					</div>
				)}
				{state.status === "error" && (
					<div className="flex items-start gap-2 text-sm text-error" role="alert">
						<CircleXIcon className="mt-0.5 size-3 shrink-0" />
						<span className="break-words">Couldn't load this page: {state.error}</span>
					</div>
				)}
			</div>
		</div>
	)
})

HtmlRenderRow.displayName = "HtmlRenderRow"
