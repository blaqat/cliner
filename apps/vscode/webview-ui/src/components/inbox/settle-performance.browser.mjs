import { mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"

// Build first: from webview-ui run bun run build.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE can select an existing Chromium installation.
const build = fileURLToPath(new URL("../../../build", import.meta.url))
const output = process.env.SETTLE_PROFILE_DIR ?? path.join(os.tmpdir(), "cline-settle-benchmark")
await mkdir(output, { recursive: true })
const themeText = await readFile(new URL("../../../.storybook/themes.ts", import.meta.url), "utf8")
const dark = Object.fromEntries(
	[...themeText.split("const mockVSCodeLightTheme")[0].matchAll(/"(--vscode-[^"]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]),
)
const light = Object.fromEntries(
	[...themeText.split("const mockVSCodeLightTheme")[1].matchAll(/"(--vscode-[^"]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]),
)
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
for (const count of process.argv[2] ? [Number(process.argv[2])] : [1, 3, 5, 10]) {
	const page = await browser.newPage({ viewport: { width: 340, height: 900 } })
	page.on("pageerror", (error) => console.log("PAGEERROR", error.stack))
	await page.route("http://cline.test/**", async (route) => {
		const url = new URL(route.request().url())
		const p = url.pathname === "/" ? "/index.html" : url.pathname
		const contentType = p.endsWith(".js")
			? "text/javascript"
			: p.endsWith(".css")
				? "text/css"
				: p.endsWith(".html")
					? "text/html"
					: "application/octet-stream"
		try {
			await route.fulfill({ body: await readFile(build + p), contentType })
		} catch {
			await route.abort()
		}
	})
	await page.addInitScript(() => {
		const now = Date.now()
		const count = Number(new URL(location.href).searchParams.get("threads") || 10)
		const history = Array.from({ length: 500 }, (_, i) => ({
			id: `thread-${i}`,
			task: `Workspace investigation ${i}`,
			title: `Thread ${i + 1}`,
			ts: now - i * 1000,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			isSettled: false,
			...(i < count ? { taskGroupId: "group" } : {}),
		}))
		const group = { id: "group", title: "Release checklist", tags: [], createdAt: now, updatedAt: now, noteCount: 0 }
		window.fixture = { history, group, pending: [], requests: [], subscriptions: {} }
		window.reply = (r, message, error) =>
			window.postMessage(
				{
					type: "grpc_response",
					grpc_response: { request_id: r.request_id, message, error, is_streaming: !!r.is_streaming },
				},
				"*",
			)
		window.postState = (patch) =>
			window.reply(window.fixture.subscriptions.subscribeToState, { stateJson: JSON.stringify(patch) })
		window.acquireVsCodeApi = () => ({
			getState: () => ({}),
			setState: () => {},
			postMessage: ({ grpc_request: r }) => {
				if (!r) return
				window.fixture.requests.push(r)
				if (r.is_streaming) {
					window.fixture.subscriptions[r.method] = r
					if (r.method === "subscribeToState")
						setTimeout(
							() =>
								window.postState({
									welcomeViewCompleted: true,
									shouldShowAnnouncement: false,
									taskHistory: history,
									taskHistoryVersion: "1",
									taskGroups: [group],
									oneViewEnabled: false,
									sessionStatuses: {},
									modelSettingsMigration: { status: "complete", version: 1 },
								}),
							0,
						)
					return
				}
				if (["toggleTaskSettled", "toggleTaskStashed", "clearTask"].includes(r.method)) {
					window.fixture.pending.push(r)
					return
				}
				let result = {
					providers: [],
					models: [],
					profiles: [],
					workspaceRoots: [],
					roots: [],
					taskGroups: [],
					runs: [],
					groups: [],
					commands: [],
					files: [],
				}
				if (r.method === "getTaskGroup")
					result = {
						group,
						notes: [],
						threads: history.slice(0, count).map((t) => ({
							threadId: t.id,
							title: t.title,
							task: t.task,
							ts: t.ts,
							startedTs: t.ts,
							read: [],
							wrote: [],
						})),
					}
				else if (r.method === "getAutomationRuns") result = { runsJson: "[]" }
				else if (r.method === "getWorkspaceRoots") result = { paths: [] }
				else if (r.method === "showTaskWithId")
					window.postState({
						currentTaskItem: history.find((t) => t.id === r.message.value),
						clineMessages: [{ ts: now, type: "say", say: "task", text: "Check workspace" }],
						epoch: 2,
					})
				setTimeout(() => window.reply(r, result), 0)
			},
		})
	})
	await page.goto(`http://cline.test/?threads=${count}`)
	await page.evaluate((theme) => {
		for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v)
		document.body.style.cssText =
			"background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px -apple-system,BlinkMacSystemFont,sans-serif"
		document.body.className = "vscode-dark"
	}, dark)
	await page.waitForSelector('[data-testid="inbox-task-group-row"]', { timeout: 20000 })

	await page.getByTestId("inbox-task-group-row").click()
	await page.getByRole("button", { name: "Task actions", exact: true }).waitFor()
	await page.screenshot({ path: path.join(output, `task-${count}-narrow-dark.png`) })
	await page.getByRole("button", { name: "Task actions", exact: true }).click()
	const clickMs = await page.evaluate(async () => {
		const target = [...document.querySelectorAll("[role=menuitem]")].find((el) => el.textContent === "Settle all")
		const start = performance.now()
		target.click()
		await new Promise((resolve) => requestAnimationFrame(resolve))
		return {
			clickToNextFrameMs: performance.now() - start,
			settledRows: document.querySelectorAll('[data-settled="true"]').length,
			pendingRpc: window.fixture.pending.length,
		}
	})
	console.log(JSON.stringify({ threads: count, ...clickMs }))
	if (clickMs.settledRows !== count || clickMs.pendingRpc !== 1)
		throw new Error("Settle must render every thread before the RPC completes")
	await page.screenshot({ path: path.join(output, `settled-${count}-narrow-dark.png`) })
	await page.evaluate((theme) => {
		for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v)
		document.body.className = "vscode-light"
	}, light)
	await page.screenshot({ path: path.join(output, `settled-${count}-narrow-light.png`) })
	await page.setViewportSize({ width: 1100, height: 900 })
	await page.evaluate((theme) => {
		for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v)
		document.body.className = "vscode-light"
	}, light)
	await page.screenshot({ path: path.join(output, `settled-${count}-wide-light.png`) })
	await page.evaluate((theme) => {
		for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v)
		document.body.className = "vscode-dark"
	}, dark)
	await page.screenshot({ path: path.join(output, `settled-${count}-wide-dark.png`) })
	// The VS Code title-bar + is delivered through this same subscribed event.
	await page.evaluate(() => window.reply(window.fixture.subscriptions.subscribeToChatButtonClicked, { goHome: true }))
	await page.getByTestId("inbox-task-group-row").waitFor()
	if (!(await page.locator("body").innerText()).includes("What can I do for you?"))
		throw new Error("Plus failed to return home during pending settle")
	await page.screenshot({ path: path.join(output, `home-${count}-wide-light.png`) })
	await page.close()
}
await browser.close()
