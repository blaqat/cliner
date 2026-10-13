export const HTML_RENDER_TOOL = "html_render"
export const HTML_PREVIEW_TOOL = "html_preview"
export interface HtmlRenderRef {
	attachmentId: string
	title: string
	height: number
	heights?: [number, number][]
}
export function parseHtmlRenderRef(text: string | undefined): HtmlRenderRef | undefined {
	if (!text) return undefined
	try {
		const parsed = JSON.parse(text)
		const ref = parsed.htmlRender ?? parsed
		if (
			!ref ||
			typeof ref.attachmentId !== "string" ||
			!/^[a-zA-Z0-9_-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-html$/.test(ref.attachmentId) ||
			typeof ref.title !== "string" ||
			!Number.isFinite(ref.height) ||
			ref.height < 80 ||
			ref.height > 2000
		)
			return undefined
		if (
			ref.heights !== undefined &&
			(!Array.isArray(ref.heights) ||
				!ref.heights.every(
					(pair: unknown) =>
						Array.isArray(pair) &&
						pair.length === 2 &&
						pair.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0),
				))
		)
			return undefined
		return {
			attachmentId: ref.attachmentId,
			title: ref.title,
			height: ref.height,
			...(ref.heights ? { heights: ref.heights } : {}),
		}
	} catch {
		return undefined
	}
}
export const HTML_RENDER_THEME_VARS: readonly string[] = [
	"--background",
	"--foreground",
	"--muted",
	"--muted-foreground",
	"--card",
	"--border",
	"--accent",
	"--accent-foreground",
	"--primary",
	"--chart-1",
	"--chart-2",
	"--chart-3",
	"--chart-4",
	"--chart-5",
	"--font-sans",
	"--font-mono",
]
export function heightForWidth(ref: HtmlRenderRef, width: number): number {
	const samples = [...(ref.heights ?? [])].sort((a, b) => a[0] - b[0])
	if (!samples.length) return ref.height
	const baseline = samples.find(([w]) => w === 728)?.[1]
	const cap = baseline !== undefined && ref.height >= baseline ? 2000 : ref.height
	const upper = samples.findIndex(([w]) => w >= width)
	const height =
		upper < 0
			? samples[samples.length - 1][1]
			: upper === 0 || samples[upper][0] === width
				? samples[upper][1]
				: Math.max(samples[upper - 1][1], samples[upper][1])
	return Math.max(80, Math.min(cap, Math.ceil(height)))
}
export function buildThemeBootstrap(): string {
	return `<style id="html-render-base">:root{color-scheme:light dark;--background:#fff;--foreground:#18181b;--muted:#f4f4f5;--muted-foreground:#71717a;--card:#fff;--border:#e4e4e7;--accent:#e4e4e7;--accent-foreground:#18181b;--primary:#3b82f6;--chart-1:#3b82f6;--chart-2:#10b981;--chart-3:#f59e0b;--chart-4:#a855f7;--chart-5:#ef4444;--font-sans:system-ui,sans-serif;--font-mono:monospace}@media(prefers-color-scheme:dark){:root{--background:#18181b;--foreground:#fafafa;--muted:#27272a;--muted-foreground:#a1a1aa;--card:#27272a;--border:#3f3f46;--accent:#3f3f46;--accent-foreground:#fafafa}}html,body{background:transparent;color:var(--foreground);font-family:var(--font-sans);margin:0;scrollbar-width:none}::-webkit-scrollbar{display:none}*{box-sizing:border-box}:focus-visible{outline:2px solid var(--primary);outline-offset:2px}</style><script>(function(){const keys=${JSON.stringify(HTML_RENDER_THEME_VARS)};function theme(t){if(!t)return;const r=document.documentElement;if(t.appearance==='dark'||t.appearance==='light'){r.style.colorScheme=t.appearance;r.style.setProperty('--foreground',t.appearance==='dark'?'#fafafa':'#18181b');r.style.setProperty('--background',t.appearance==='dark'?'#18181b':'#fff')}for(const k of keys){if(t.variables&&typeof t.variables[k]==='string')r.style.setProperty(k,t.variables[k])}}try{theme(window.__HTML_RENDER_THEME__||JSON.parse(decodeURIComponent(location.hash.replace(/^#theme=/,''))))}catch(e){}addEventListener('message',function(e){if(e.source!==parent)return;const m=e.data;if(m&&m.jsonrpc==='2.0'&&m.method==='ui/notifications/host-context-changed')theme({appearance:m.params.theme,variables:m.params.styles&&m.params.styles.variables})});let last=0;function report(){const h=Math.ceil(Math.max(document.body?document.body.scrollHeight:0,document.body?document.body.getBoundingClientRect().height:0));if(h!==last){last=h;parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:h}},'*')}}addEventListener('DOMContentLoaded',function(){new ResizeObserver(report).observe(document.body);report()});let seq=0;document.addEventListener('click',function(e){const a=e.target.closest&&e.target.closest('a[href]');if(!a)return;try{const u=new URL(a.href);if(u.protocol==='http:'||u.protocol==='https:'){e.preventDefault();parent.postMessage({jsonrpc:'2.0',id:'t3-link-'+(++seq),method:'ui/open-link',params:{url:u.href}},'*')}}catch(e){}})})();</script>`
}
