import { useEffect, useState } from "react"

export type HtmlRenderAppearance = "dark" | "light"

export interface HtmlRenderTheme {
	appearance: HtmlRenderAppearance
	variables: Record<string, string>
}

const SANS_FALLBACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

/**
 * Each page variable maps to VS Code theme colors, tried in order. The last
 * entry per appearance is used when the host defines none of them (tests,
 * stripped-down themes).
 */
const VARIABLE_SOURCES: Record<string, { vscode: string[]; dark: string; light: string }> = {
	"--background": { vscode: ["--vscode-sideBar-background", "--vscode-editor-background"], dark: "#1e1e1e", light: "#ffffff" },
	"--foreground": { vscode: ["--vscode-foreground", "--vscode-editor-foreground"], dark: "#cccccc", light: "#3b3b3b" },
	"--muted": {
		vscode: ["--vscode-textCodeBlock-background", "--vscode-toolbar-hoverBackground"],
		dark: "#2a2a2a",
		light: "#f2f2f2",
	},
	"--muted-foreground": {
		vscode: ["--vscode-descriptionForeground", "--vscode-disabledForeground"],
		dark: "#9d9d9d",
		light: "#717171",
	},
	"--card": {
		vscode: ["--vscode-editorWidget-background", "--vscode-editor-background"],
		dark: "#252526",
		light: "#f3f3f3",
	},
	"--border": {
		vscode: ["--vscode-panel-border", "--vscode-widget-border", "--vscode-editorGroup-border"],
		dark: "#3c3c3c",
		light: "#e5e5e5",
	},
	"--accent": {
		vscode: ["--vscode-list-hoverBackground", "--vscode-toolbar-hoverBackground"],
		dark: "#2a2d2e",
		light: "#e8e8e8",
	},
	"--accent-foreground": {
		vscode: ["--vscode-list-hoverForeground", "--vscode-foreground"],
		dark: "#cccccc",
		light: "#3b3b3b",
	},
	"--primary": {
		vscode: ["--vscode-button-background", "--vscode-focusBorder"],
		dark: "#0e639c",
		light: "#005fb8",
	},
	"--chart-1": { vscode: ["--vscode-charts-blue"], dark: "#3794ff", light: "#1a85ff" },
	"--chart-2": { vscode: ["--vscode-charts-green"], dark: "#89d185", light: "#388a34" },
	"--chart-3": { vscode: ["--vscode-charts-yellow"], dark: "#cca700", light: "#bf8803" },
	"--chart-4": { vscode: ["--vscode-charts-purple"], dark: "#b180d7", light: "#652d90" },
	"--chart-5": { vscode: ["--vscode-charts-red"], dark: "#f14c4c", light: "#e51400" },
}

/** VS Code marks the webview body with the active theme kind. */
export function readHtmlRenderAppearance(body: HTMLElement | null = document.body): HtmlRenderAppearance {
	const kind = body?.getAttribute("data-vscode-theme-kind")
	if (kind) {
		return kind === "vscode-light" || kind === "vscode-high-contrast-light" ? "light" : "dark"
	}
	if (body?.classList.contains("vscode-light") || body?.classList.contains("vscode-high-contrast-light")) {
		return "light"
	}
	if (body?.classList.contains("vscode-dark") || body?.classList.contains("vscode-high-contrast")) {
		return "dark"
	}
	return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark"
}

/**
 * Resolves the page theme from the webview's computed `--vscode-*` colors so
 * the frame looks like part of the chat. Values are concrete (computed), since
 * the sandboxed page cannot see the host's custom properties.
 */
export function readHtmlRenderTheme(root: HTMLElement = document.documentElement): HtmlRenderTheme {
	const appearance = readHtmlRenderAppearance()
	const styles = getComputedStyle(root)
	const read = (name: string) => styles.getPropertyValue(name).trim()
	const variables: Record<string, string> = {}
	for (const [name, source] of Object.entries(VARIABLE_SOURCES)) {
		variables[name] = source.vscode.map(read).find(Boolean) || source[appearance]
	}
	const sans = read("--vscode-font-family")
	const mono = read("--vscode-editor-font-family")
	variables["--font-sans"] = sans ? `${sans}, ${SANS_FALLBACK}` : SANS_FALLBACK
	variables["--font-mono"] = mono ? `${mono}, ${MONO_FALLBACK}` : MONO_FALLBACK
	return { appearance, variables }
}

function sameTheme(a: HtmlRenderTheme, b: HtmlRenderTheme): boolean {
	if (a.appearance !== b.appearance) {
		return false
	}
	const keys = Object.keys(a.variables)
	return keys.length === Object.keys(b.variables).length && keys.every((key) => a.variables[key] === b.variables[key])
}

/**
 * Current page theme, updated when VS Code switches themes. VS Code rewrites
 * the `<html>` style attribute (the `--vscode-*` values) and the body theme
 * class/attribute on a theme change, so those are the only things observed.
 */
export function useHtmlRenderTheme(): HtmlRenderTheme {
	const [theme, setTheme] = useState(readHtmlRenderTheme)

	useEffect(() => {
		const update = () => {
			const next = readHtmlRenderTheme()
			setTheme((previous) => (sameTheme(previous, next) ? previous : next))
		}
		const observer = new MutationObserver(update)
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] })
		observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind"] })
		update()
		return () => observer.disconnect()
	}, [])

	return theme
}
