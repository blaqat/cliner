import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureTaskDirectoryExists } from "@/core/storage/disk"
import { buildThemeBootstrap, type HtmlRenderRef } from "@/shared/htmlRender"

export const HTML_MAX_CHARS = 512_000
const PAGE_MAX_BYTES = 25 * 1024 * 1024
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export function attachmentTaskId(id: string): string {
	const match = /^([a-zA-Z0-9_-]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-html$/.exec(id)
	if (!match) throw new Error("Invalid HTML render attachment ID")
	return match[1]
}
function imageMime(data: Buffer): string | undefined {
	if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
	if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg"
	if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return "image/gif"
	if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp"
	if (data.subarray(0, 2).toString() === "BM") return "image/bmp"
	if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(data.subarray(0, 1024).toString())) return "image/svg+xml"
	return undefined
}
export async function prepareHtml(html: string): Promise<string> {
	if (typeof html !== "string" || !html.trim() || html.length > HTML_MAX_CHARS)
		throw new Error(`HTML must contain 1-${HTML_MAX_CHARS} characters`)
	const matches = [...html.matchAll(/(["'])([^"'\n]+\.(?:png|jpe?g|gif|webp|svg|bmp))(\1)/gi)]
	const replacements = new Map<string, string>()
	let imageBytes = 0
	for (const match of matches) {
		const source = match[2]
		if (
			!(path.isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("file://")) ||
			replacements.has(source)
		)
			continue
		const filename = source.startsWith("file://") ? fileURLToPath(source) : source
		let data: Buffer
		try {
			const stat = await fs.stat(filename)
			if (!stat.isFile() || stat.size > IMAGE_MAX_BYTES) throw new Error("image exceeds 10 MiB or is not a file")
			data = await fs.readFile(filename)
		} catch (error) {
			throw new Error(`Cannot inline local image ${filename}: ${error instanceof Error ? error.message : error}`)
		}
		const mime = imageMime(data)
		if (!mime) throw new Error(`Unsupported local image content: ${filename}`)
		imageBytes += data.length
		if (imageBytes > PAGE_MAX_BYTES) throw new Error("Local images exceed 25 MiB total")
		replacements.set(source, `data:${mime};base64,${data.toString("base64")}`)
	}
	html = html.replace(/(["'])([^"'\n]+\.(?:png|jpe?g|gif|webp|svg|bmp))(\1)/gi, (full, quote, source) =>
		replacements.has(source) ? `${quote}${replacements.get(source)}${quote}` : full,
	)
	// CSS url(/absolute/image.png) may omit quotes.
	const urls = [...html.matchAll(/url\(\s*((?:\/|file:\/\/|[A-Za-z]:[\\/])[^)'"\n]+\.(?:png|jpe?g|gif|webp|svg|bmp))\s*\)/gi)]
	for (const match of urls) {
		const prepared = await prepareHtml(`<img src="${match[1].trim()}">`)
		const data = prepared.match(/<img src="(data:[^"]+)"/)
		if (data) html = html.replace(match[0], `url("${data[1]}")`)
	}
	const bootstrap = `<meta name="viewport" content="width=device-width,initial-scale=1">${buildThemeBootstrap()}`
	html = /<head(?:\s[^>]*)?>/i.test(html)
		? html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + bootstrap)
		: /<html(?:\s[^>]*)?>/i.test(html)
			? html.replace(/<html(?:\s[^>]*)?>/i, (root) => `${root}<head>${bootstrap}</head>`)
			: `<!doctype html><html><head>${bootstrap}</head><body>${html}</body></html>`
	if (Buffer.byteLength(html) > PAGE_MAX_BYTES) throw new Error("Prepared HTML exceeds 25 MiB")
	return html
}
export async function getHtmlRender(id: string): Promise<string> {
	const taskId = attachmentTaskId(id)
	return fs.readFile(path.join(await ensureTaskDirectoryExists(taskId), "html-renders", `${id}.html`), "utf8")
}
export async function renderHtml(taskId: string, html: string, title: string, height: number): Promise<HtmlRenderRef> {
	if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("HTML render requires a valid active task ID")
	const prepared = await prepareHtml(html)
	const attachmentId = `${taskId}-${randomUUID()}-html`
	const directory = path.join(await ensureTaskDirectoryExists(taskId), "html-renders")
	await fs.mkdir(directory, { recursive: true })
	await fs.writeFile(path.join(directory, `${attachmentId}.html`), prepared, { flag: "wx" })
	const ref: HtmlRenderRef = { attachmentId, title, height }
	return ref
}
