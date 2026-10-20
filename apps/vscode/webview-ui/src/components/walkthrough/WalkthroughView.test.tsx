import type { ChangeWalkthrough } from "@shared/Walkthrough"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reviewStorageKey } from "./reviewState"
import WalkthroughView from "./WalkthroughView"

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	generate: vi.fn(),
	revert: vi.fn(),
	send: vi.fn(),
	open: vi.fn(),
	openUrl: vi.fn(),
	state: {} as Record<string, unknown>,
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/components/chat/task-header/Breadcrumb", () => ({
	Breadcrumb: ({ crumbs }: { crumbs: { label: string }[] }) => <nav>{crumbs.map((c) => c.label).join(" › ")}</nav>,
}))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		getChangeWalkthrough: mocks.get,
		generateChangeWalkthrough: mocks.generate,
		revertWalkthroughChange: mocks.revert,
		sendWalkthroughNotes: mocks.send,
		openWalkthroughDiff: mocks.open,
	},
	UiServiceClient: { openUrl: (...args: unknown[]) => mocks.openUrl(...args) },
}))

const hunk = (id: string, path: string, patch: string, extra: Partial<ChangeWalkthrough["hunks"][number]> = {}) => ({
	id,
	fingerprint: `fp-${id}`,
	fileId: `file-${path}`,
	path,
	header: patch.split("\n")[0],
	patch,
	oldStart: 1,
	newStart: 1,
	...extra,
})

const fixture: ChangeWalkthrough = {
	version: 1,
	taskId: "task",
	scope: "thread",
	fingerprint: "diff-1",
	source: "fallback",
	title: "Cap bulk exports at 10k rows",
	focus: "Async worker plus a `MAX_EXPORT_ROWS` cap.",
	warnings: ["web: changes outside the primary root need Whole git diff."],
	chapters: [
		{
			id: "c1",
			title: "Runtime",
			stops: [
				{
					id: "s1",
					title: "Stop the request waiting",
					prose: "The export enqueues a job; `ExportWorker` picks it up.",
					hunkIds: ["h1", "h2"],
				},
				{ id: "s2", title: "Cap at 10k rows", prose: "Lives in `shared`.", hunkIds: ["h3"] },
			],
		},
		{ id: "c2", title: "UI", stops: [{ id: "s3", title: "Banner past the cap", prose: "", hunkIds: ["h4"] }] },
	],
	support: [{ id: "support", title: "Supporting changes", prose: "", hunkIds: ["h5"] }],
	hunks: [
		hunk(
			"h1",
			"api/export/controller.ts",
			"@@ -1,2 +1,2 @@\n context\n-  const csv = await buildCsv(rows)\n+  const job = await jobs.enqueue({ rows })\n",
		),
		hunk("h2", "api/export/controller.ts", "@@ -20,1 +20,2 @@\n+  return { jobId: job.id }\n"),
		hunk("h3", "shared/limits.ts", "@@ -0,0 +1,1 @@\n+export const MAX_EXPORT_ROWS = 10_000\n"),
		hunk("h4", "web/logo.png", "Binary file changed", { synthetic: true }),
		hunk("h5", "bun.lock", "@@ -1,1 +1,1 @@\n-lock-old\n+lock-new\n"),
	],
}

const response = (walk: ChangeWalkthrough) => ({ value: JSON.stringify(walk) })
const sent = (fn: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(fn.mock.calls[call][0].value)
const stop = (title: string) => screen.getByRole("article", { name: title })

const baseState = () => ({
	apiConfigProfiles: [
		{ id: "cfg-haiku", name: "Haiku", provider: "anthropic", modelId: "haiku" },
		{ id: "cfg-opus", name: "Opus", provider: "anthropic", modelId: "opus" },
	],
	// Generate picks named profiles (Settings › Profiles), not configurations.
	profiles: [
		{ id: "fast", name: "Fast", configurationId: "cfg-haiku" },
		{ id: "deep", name: "Deep", configurationId: "cfg-opus", reasoningEffort: "high" },
	],
	walkthroughGenerateProfileId: "deep",
	currentTaskItem: { id: "task", ts: 1, task: "Implement steps", title: "Implement steps 1–2", taskGroupId: "group" },
	taskHistory: [],
	taskGroups: [{ id: "group", title: "Bulk invoice export" }],
	navigateToTaskGroup: vi.fn(),
	navigateToSettings: vi.fn(),
	windowFocused: true,
	clineMessages: [],
})

async function renderPage(onDone = vi.fn()) {
	const view = render(<WalkthroughView onDone={onDone} taskId="task" />)
	await screen.findByText("Stop the request waiting")
	return { ...view, onDone }
}

beforeEach(() => {
	vi.clearAllMocks()
	const storage = new Map<string, string>()
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	})
	// The Generate ▾ popover measures itself.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	mocks.state = baseState()
	mocks.get.mockResolvedValue(response(fixture))
	mocks.generate.mockResolvedValue(
		response({ ...fixture, source: "generated", profileId: "fast", chapters: [fixture.chapters[0]] }),
	)
	mocks.revert.mockResolvedValue(
		response({
			...fixture,
			fingerprint: "diff-2",
			chapters: [{ id: "c1", title: "Runtime", stops: [{ ...fixture.chapters[0].stops[0], id: "s1", hunkIds: ["h1"] }] }],
		}),
	)
	mocks.send.mockResolvedValue({})
	mocks.open.mockResolvedValue({})
	mocks.openUrl.mockResolvedValue({})
})
afterEach(() => vi.unstubAllGlobals())

describe("WalkthroughView", () => {
	it("renders chapters, stops and hunks from the document, with support collapsed", async () => {
		await renderPage()
		expect(screen.getByRole("navigation")).toHaveTextContent("Home › Bulk invoice export › Implement steps 1–2 › Walkthrough")
		expect(screen.getByRole("heading", { name: "Cap bulk exports at 10k rows" })).toBeVisible()
		expect(screen.getByText("MAX_EXPORT_ROWS").tagName).toBe("CODE")
		expect(screen.getByRole("region", { name: "Runtime" })).toBeVisible()
		expect(screen.getByRole("region", { name: "UI" })).toBeVisible()
		expect(screen.getByTestId("walkthrough-source")).toHaveTextContent("From turns")
		expect(screen.getByTestId("walkthrough-progress")).toHaveTextContent("0 / 3 stops reviewed")
		expect(screen.getByText(/changes outside the primary root/)).toBeVisible()

		// Two hunks of one file sit under one file header.
		const first = stop("Stop the request waiting")
		expect(within(first).getAllByTestId("walkthrough-file")).toHaveLength(1)
		expect(within(first).getByText(/const job = await jobs.enqueue/)).toBeVisible()
		expect(within(first).getByText(/const csv = await buildCsv/).textContent).toMatch(/^−/)

		// A binary file says why it can't be reverted.
		const banner = stop("Banner past the cap")
		expect(within(banner).getByText(/Binary file: .*can't be reverted here/)).toBeVisible()
		expect(within(banner).queryByRole("button", { name: "Revert file" })).toBeNull()

		// Support is collapsed until opened.
		expect(screen.getByTestId("walkthrough-support")).toHaveTextContent("bun.lock")
		expect(screen.queryByText(/lock-new/)).toBeNull()
		fireEvent.click(within(screen.getByTestId("walkthrough-support")).getByRole("button", { expanded: false }))
		expect(screen.getByText(/lock-new/)).toBeVisible()
	})

	it("collapses a hunk and opens a file diff by host file id", async () => {
		await renderPage()
		const first = stop("Stop the request waiting")
		fireEvent.click(within(first).getByRole("button", { name: /Collapse hunk @@ -1,2/ }))
		expect(within(first).queryByText(/const job = await jobs.enqueue/)).toBeNull()
		expect(within(first).getByText(/jobId: job.id/)).toBeVisible()
		fireEvent.click(within(first).getByRole("button", { name: "Open diff" }))
		await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))
		expect(sent(mocks.open)).toEqual({
			taskId: "task",
			scope: "thread",
			fingerprint: "diff-1",
			fileId: "file-api/export/controller.ts",
		})
	})

	it("adds and edits notes with quick chips, keeps them on reviewed stops, then sends one message and returns", async () => {
		const { onDone } = await renderPage()
		const sendButton = screen.getByRole("button", { name: "Send to thread" })
		expect(sendButton).toBeDisabled()
		expect(screen.getByTestId("walkthrough-send-bar")).toHaveTextContent("No notes yet")

		const first = stop("Stop the request waiting")
		fireEvent.click(within(first).getByRole("button", { name: "Add note" }))
		fireEvent.click(within(first).getByRole("button", { name: "Add a test for this" }))
		expect(within(first).getByLabelText("Note on Stop the request waiting")).toHaveValue("Add a test for this.")
		fireEvent.click(within(first).getByRole("button", { name: "Done" }))
		expect(within(first).getByText("Add a test for this.")).toBeVisible()

		fireEvent.click(within(first).getByRole("button", { name: "Edit note" }))
		fireEvent.change(within(first).getByLabelText("Note on Stop the request waiting"), {
			target: { value: "Should the job id be a UUID?" },
		})
		fireEvent.click(within(first).getByRole("button", { name: "Done" }))

		fireEvent.click(within(first).getByRole("button", { name: "Mark reviewed" }))
		expect(within(first).getByRole("button", { name: "Reviewed" })).toBeVisible()
		expect(within(first).getByText("Should the job id be a UUID?")).toBeVisible()
		expect(screen.getByTestId("walkthrough-progress")).toHaveTextContent("1 / 3 stops reviewed")

		fireEvent.click(screen.getByRole("button", { name: "Add a note on the whole change" }))
		fireEvent.change(screen.getByLabelText("Note on the whole change"), { target: { value: "Check the error path." } })
		expect(screen.getByTestId("walkthrough-send-bar")).toHaveTextContent("2 notes")

		fireEvent.click(sendButton)
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
		expect(mocks.send).toHaveBeenCalledTimes(1)
		expect(sent(mocks.send)).toEqual({
			taskId: "task",
			scope: "thread",
			fingerprint: "diff-1",
			stopNotes: { s1: "Should the job id be a UUID?" },
			overallNote: "Check the error path.",
		})
		expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(onDone.mock.invocationCallOrder[0])
	})

	it("persists reviewed marks and notes per task, scope and fingerprint", async () => {
		const { unmount } = await renderPage()
		const first = stop("Stop the request waiting")
		fireEvent.click(within(first).getByRole("button", { name: "Mark reviewed" }))
		fireEvent.click(within(first).getByRole("button", { name: "Add note" }))
		fireEvent.change(within(first).getByLabelText("Note on Stop the request waiting"), { target: { value: "Keep me" } })
		unmount()
		expect(Object.keys(JSON.parse(localStorage.getItem(reviewStorageKey("task", "thread")) ?? "{}"))).toEqual(["diff-1"])

		await renderPage()
		expect(screen.getByTestId("walkthrough-progress")).toHaveTextContent("1 / 3 stops reviewed")
		expect(within(stop("Stop the request waiting")).getByText("Keep me")).toBeVisible()
		expect(screen.queryByTestId("walkthrough-moved")).toBeNull()
	})

	it("flags a changed fingerprint and drops the old review state only after Refresh", async () => {
		localStorage.setItem(
			reviewStorageKey("task", "thread"),
			JSON.stringify({ "diff-0": { fallback: { notes: { s1: "Old note" }, reviewed: { s2: true } } } }),
		)
		await renderPage()
		expect(screen.getByTestId("walkthrough-moved")).toHaveTextContent("Changes moved; refresh.")
		expect(screen.getByTestId("walkthrough-moved")).toHaveTextContent("1 note and 1 reviewed")
		expect(screen.queryByText("Old note")).toBeNull()
		expect(JSON.parse(localStorage.getItem(reviewStorageKey("task", "thread")) ?? "{}")).toHaveProperty("diff-0")

		fireEvent.click(within(screen.getByTestId("walkthrough-moved")).getByRole("button", { name: "Refresh" }))
		await waitFor(() => expect(screen.queryByTestId("walkthrough-moved")).toBeNull())
		expect(localStorage.getItem(reviewStorageKey("task", "thread"))).toBeNull()
	})

	it("notices the diff moving while open, keeps the page as it was, and refreshes on request", async () => {
		const { rerender } = await renderPage()
		fireEvent.click(within(stop("Cap at 10k rows")).getByRole("button", { name: "Mark reviewed" }))
		mocks.get.mockResolvedValue(response({ ...fixture, fingerprint: "diff-2" }))
		mocks.state = { ...mocks.state, clineMessages: [{ ts: 2 }] }
		rerender(<WalkthroughView onDone={vi.fn()} taskId="task" />)
		await waitFor(() => expect(screen.getByTestId("walkthrough-moved")).toBeVisible(), { timeout: 3000 })
		// Still showing the reviewed diff, and nothing can be sent against it.
		expect(screen.getByTestId("walkthrough-progress")).toHaveTextContent("1 / 3 stops reviewed")
		expect(screen.getByRole("button", { name: "Send to thread" })).toBeDisabled()

		fireEvent.click(within(screen.getByTestId("walkthrough-moved")).getByRole("button", { name: "Refresh" }))
		await waitFor(() => expect(screen.queryByTestId("walkthrough-moved")).toBeNull())
		expect(screen.getByTestId("walkthrough-progress")).toHaveTextContent("0 / 3 stops reviewed")
		expect(localStorage.getItem(reviewStorageKey("task", "thread"))).toBeNull()
	})

	it("asks inline before reverting a hunk or a file", async () => {
		await renderPage()
		const first = stop("Stop the request waiting")
		fireEvent.click(within(first).getAllByRole("button", { name: "Revert hunk" })[0])
		expect(mocks.revert).not.toHaveBeenCalled()
		expect(within(first).getByRole("alert")).toHaveTextContent("Revert this hunk?")
		fireEvent.click(within(within(first).getByRole("alert")).getByRole("button", { name: "Cancel" }))
		expect(within(first).queryByRole("alert")).toBeNull()

		fireEvent.click(within(first).getByRole("button", { name: "Revert file" }))
		expect(within(first).getByRole("alert")).toHaveTextContent("Revert every change to controller.ts?")
		fireEvent.click(within(first).getAllByRole("button", { name: "Revert hunk" })[1])
		const alert = within(first).getByRole("alert")
		expect(alert).toHaveTextContent("Revert this hunk?")
		fireEvent.click(within(alert).getByRole("button", { name: "Revert hunk" }))
		await waitFor(() => expect(mocks.revert).toHaveBeenCalledTimes(1))
		expect(sent(mocks.revert)).toEqual({
			taskId: "task",
			scope: "thread",
			fingerprint: "diff-1",
			fileId: "file-api/export/controller.ts",
			hunkId: "h2",
			confirmed: true,
		})
		await waitFor(() => expect(screen.queryByText("Cap at 10k rows")).toBeNull())
	})

	it("carries notes to the same stop after the user's own revert", async () => {
		await renderPage()
		const first = stop("Stop the request waiting")
		fireEvent.click(within(first).getByRole("button", { name: "Add note" }))
		fireEvent.change(within(first).getByLabelText("Note on Stop the request waiting"), { target: { value: "Survives" } })
		fireEvent.click(within(first).getByRole("button", { name: "Done" }))
		fireEvent.click(within(stop("Cap at 10k rows")).getByRole("button", { name: "Revert file" }))
		fireEvent.click(within(within(stop("Cap at 10k rows")).getByRole("alert")).getByRole("button", { name: "Revert file" }))
		await waitFor(() => expect(screen.queryByText("Cap at 10k rows")).toBeNull())
		expect(within(stop("Stop the request waiting")).getByText("Survives")).toBeVisible()
		expect(screen.queryByTestId("walkthrough-moved")).toBeNull()
	})

	it("never generates on mount; Generate uses the remembered profile, ▾ picks another, then Regenerate", async () => {
		await renderPage()
		expect(mocks.generate).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: /Generate$/ })).toHaveAttribute("title", "Generate with Deep")

		fireEvent.click(screen.getByRole("button", { name: "Choose Generate profile" }))
		// Each profile shows its model and effort under its name.
		expect(await screen.findByRole("menuitemradio", { name: /Deep.*Anthropic · opus · high effort/ })).toBeTruthy()
		fireEvent.click(await screen.findByRole("menuitemradio", { name: /Fast/ }))
		expect(mocks.generate).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: /Generate$/ })).toHaveAttribute("title", "Generate with Fast")

		fireEvent.click(screen.getByRole("button", { name: /Generate$/ }))
		await waitFor(() => expect(screen.getByTestId("walkthrough-source")).toHaveTextContent("Generated · Fast"))
		expect(mocks.generate).toHaveBeenCalledTimes(1)
		expect(sent(mocks.generate)).toMatchObject({ taskId: "task", scope: "thread", profileId: "fast", regenerate: false })

		fireEvent.click(screen.getByRole("button", { name: /Regenerate$/ }))
		await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2))
		expect(sent(mocks.generate, 1)).toMatchObject({ profileId: "fast", regenerate: true })
	})

	it("moves through the Generate ▾ menu with the arrow keys, Home and End", async () => {
		await renderPage()
		fireEvent.click(screen.getByRole("button", { name: "Choose Generate profile" }))
		const fast = await screen.findByRole("menuitemradio", { name: /Fast/ })
		const deep = screen.getByRole("menuitemradio", { name: /Deep/ })
		const manage = screen.getByRole("menuitem", { name: "Manage profiles…" })
		const menu = screen.getByRole("menu")
		fast.focus()
		fireEvent.keyDown(fast, { key: "ArrowDown" })
		expect(deep).toHaveFocus()
		fireEvent.keyDown(deep, { key: "ArrowDown" })
		expect(manage).toHaveFocus()
		fireEvent.keyDown(manage, { key: "ArrowDown" })
		expect(fast).toHaveFocus()
		fireEvent.keyDown(fast, { key: "ArrowUp" })
		expect(manage).toHaveFocus()
		fireEvent.keyDown(manage, { key: "Home" })
		expect(fast).toHaveFocus()
		fireEvent.keyDown(fast, { key: "End" })
		expect(manage).toHaveFocus()
		expect(within(menu).getByRole("separator")).toBeTruthy()
	})

	it("shows a turn's short prose and reveals its full narration with Show more", async () => {
		const walk: ChangeWalkthrough = {
			...fixture,
			chapters: [
				{
					id: "c1",
					title: "Runtime",
					stops: [
						{
							id: "s1",
							title: "Stop the request waiting",
							prose: "Export now runs in a worker.",
							detail: "Plan: add a worker.\n\nRetrying the build.\n\nExport now runs in a worker.",
							hunkIds: ["h1", "h2"],
						},
						{ id: "s2", title: "Cap at 10k rows", prose: "Lives in `shared`.", hunkIds: ["h3"] },
					],
				},
			],
		}
		mocks.get.mockResolvedValue(response(walk))
		await renderPage()
		const card = stop("Stop the request waiting")
		expect(within(card).queryByText(/Retrying the build/)).toBeNull()
		fireEvent.click(within(card).getByRole("button", { name: "Show more" }))
		expect(within(card).getByText(/Retrying the build/)).toBeVisible()
		fireEvent.click(within(card).getByRole("button", { name: "Show less" }))
		expect(within(card).queryByText(/Retrying the build/)).toBeNull()
		expect(within(stop("Cap at 10k rows")).queryByRole("button", { name: "Show more" })).toBeNull()
	})

	it("opens Settings › Profiles from Manage profiles… in the Generate ▾ menu", async () => {
		await renderPage()
		fireEvent.click(screen.getByRole("button", { name: "Choose Generate profile" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Manage profiles…" }))
		expect(mocks.state.navigateToSettings).toHaveBeenCalledWith("profiles")
		await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Manage profiles…" })).toBeNull())
		expect(mocks.generate).not.toHaveBeenCalled()
	})

	describe("Regenerate with unsent notes", () => {
		const layoutB: ChangeWalkthrough = {
			...fixture,
			source: "generated",
			profileId: "fast",
			chapters: [
				{
					id: "g1",
					title: "Pipeline",
					stops: [
						{ id: "n1", title: "Export pipeline", prose: "", hunkIds: ["h1", "h2"] },
						{ id: "n2", title: "Banner", prose: "", hunkIds: ["h4"] },
					],
				},
			],
		}
		async function regenerateWithNotes() {
			await renderPage()
			fireEvent.click(screen.getByRole("button", { name: /Generate$/ }))
			await waitFor(() => expect(screen.getByTestId("walkthrough-source")).toHaveTextContent("Generated"))
			for (const [title, note] of [
				["Stop the request waiting", "Keep this note"],
				["Cap at 10k rows", "Where did this go"],
			]) {
				const card = stop(title)
				fireEvent.click(within(card).getByRole("button", { name: "Add note" }))
				fireEvent.change(within(card).getByLabelText(`Note on ${title}`), { target: { value: note } })
				fireEvent.click(within(card).getByRole("button", { name: "Done" }))
			}
			mocks.generate.mockResolvedValueOnce(response(layoutB))
			fireEvent.click(screen.getByRole("button", { name: /Regenerate$/ }))
			await screen.findByText("Export pipeline")
		}
		const stored = () => JSON.parse(localStorage.getItem(reviewStorageKey("task", "thread")) ?? "{}")

		it("moves notes to the stop over the same hunks and offers the ones that fit nowhere", async () => {
			await regenerateWithNotes()
			expect(within(stop("Export pipeline")).getByText("Keep this note")).toBeVisible()
			expect(screen.getByTestId("walkthrough-unplaced")).toHaveTextContent("1 note from the previous layout")
			expect(JSON.stringify(stored())).toContain("Cap at 10k rows: Where did this go")
		})

		it("recovers unplaced notes into the overall note", async () => {
			await regenerateWithNotes()
			fireEvent.click(
				within(screen.getByTestId("walkthrough-unplaced")).getByRole("button", { name: "Add to overall note" }),
			)
			expect(screen.queryByTestId("walkthrough-unplaced")).toBeNull()
			expect(stored()["diff-1"].overallNote).toBe("Cap at 10k rows: Where did this go")
		})

		it("drops unplaced notes only when discarded", async () => {
			await regenerateWithNotes()
			fireEvent.click(screen.getByRole("button", { name: /Regenerate$/ }))
			expect(screen.getByTestId("walkthrough-unplaced")).toBeVisible()
			fireEvent.click(within(screen.getByTestId("walkthrough-unplaced")).getByRole("button", { name: "Discard" }))
			expect(screen.queryByTestId("walkthrough-unplaced")).toBeNull()
			expect(JSON.stringify(stored())).not.toContain("Where did this go")
		})
	})

	it("shows Generate failures inline and keeps the free walkthrough", async () => {
		mocks.generate.mockRejectedValue(new Error("Choose a profile for Generate"))
		await renderPage()
		fireEvent.click(screen.getByRole("button", { name: /Generate$/ }))
		expect(await screen.findByRole("alert")).toHaveTextContent("Choose a profile for Generate")
		expect(sent(mocks.generate).profileId).toBe("deep")
		expect(screen.getByTestId("walkthrough-source")).toHaveTextContent("From turns")
	})

	it("renders Generate as one split button: both halves the same height, no cost caption", async () => {
		await renderPage()
		const split = screen.getByTestId("walkthrough-generate")
		const main = within(split).getByRole("button", { name: /Generate$/ })
		const menu = within(split).getByRole("button", { name: "Choose Generate profile" })
		for (const half of [main, menu]) expect(half.className).toMatch(/\bh-6\b/)
		expect(main.className).toMatch(/\brounded-none\b/)
		expect(menu.className).toMatch(/\brounded-none\b/)
		expect(menu.className).toContain("border-l")
		expect(main.querySelector(".codicon-sparkle")).not.toBeNull()
		expect(screen.queryByTestId("walkthrough-generate-cost")).toBeNull()
		expect(screen.queryByText(/only when you click/i)).toBeNull()
		expect(screen.queryByText(/One call to/i)).toBeNull()
		// The profile name stays where it helps: the ▾ menu and the Generated badge.
		fireEvent.click(menu)
		expect(await screen.findByRole("menuitemradio", { name: /Deep/ })).toHaveAttribute("aria-checked", "true")
	})

	describe("collapsing", () => {
		const chapterToggle = (title: string) =>
			within(screen.getByRole("region", { name: title })).getByRole("button", { name: new RegExp(`^${title}`) })

		it("toggles a chapter's stops from its header", async () => {
			await renderPage()
			const toggle = chapterToggle("Runtime")
			expect(toggle).toHaveAttribute("aria-expanded", "true")
			fireEvent.click(toggle)
			expect(toggle).toHaveAttribute("aria-expanded", "false")
			expect(screen.queryByText("Stop the request waiting")).toBeNull()
			expect(screen.queryByText("Cap at 10k rows")).toBeNull()
			// Other chapters and the numbering stay put.
			expect(stop("Banner past the cap")).toBeVisible()
			expect(within(stop("Banner past the cap")).getByText("3")).toBeTruthy()
			fireEvent.click(toggle)
			expect(stop("Stop the request waiting")).toBeVisible()
		})

		it("toggles each hunk on its own", async () => {
			await renderPage()
			const first = stop("Stop the request waiting")
			const hunk = within(first).getByRole("button", { name: /Collapse hunk @@ -1,2/ })
			expect(hunk).toHaveAttribute("aria-expanded", "true")
			fireEvent.click(hunk)
			expect(within(first).queryByText(/const job = await jobs.enqueue/)).toBeNull()
			expect(within(first).getByText(/jobId: job.id/)).toBeVisible()
			fireEvent.click(within(first).getByRole("button", { name: /Expand hunk @@ -1,2/ }))
			expect(within(first).getByText(/const job = await jobs.enqueue/)).toBeVisible()
		})

		it("collapses and expands everything from the ⋯ menu and the header toggle", async () => {
			await renderPage()
			fireEvent.click(screen.getByRole("button", { name: "More actions" }))
			fireEvent.click(await screen.findByRole("menuitem", { name: "Collapse all" }))
			expect(screen.queryAllByTestId("walkthrough-stop")).toHaveLength(0)
			for (const title of ["Runtime", "UI"]) expect(chapterToggle(title)).toHaveAttribute("aria-expanded", "false")

			// Reopening one chapter shows its stops with their hunks folded.
			fireEvent.click(chapterToggle("Runtime"))
			expect(stop("Stop the request waiting")).toBeVisible()
			expect(screen.queryByText(/const job = await jobs.enqueue/)).toBeNull()

			fireEvent.click(screen.getByRole("button", { name: "More actions" }))
			fireEvent.click(await screen.findByRole("menuitem", { name: "Expand all" }))
			expect(screen.getAllByTestId("walkthrough-stop")).toHaveLength(3)
			expect(screen.getByText(/const job = await jobs.enqueue/)).toBeVisible()

			// The header toggle flips between the two.
			fireEvent.click(screen.getByRole("button", { name: "Collapse all" }))
			expect(screen.queryAllByTestId("walkthrough-stop")).toHaveLength(0)
			fireEvent.click(screen.getByRole("button", { name: "Expand all" }))
			expect(screen.getAllByTestId("walkthrough-stop")).toHaveLength(3)
		})

		it("remembers collapse state per walkthrough while the page is open", async () => {
			await renderPage()
			fireEvent.click(chapterToggle("UI"))
			fireEvent.click(screen.getByRole("button", { name: "Whole git diff" }))
			await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
			// Another scope is its own walkthrough: nothing folded there.
			await waitFor(() => expect(chapterToggle("UI")).toHaveAttribute("aria-expanded", "true"))
			fireEvent.click(screen.getByRole("button", { name: "This thread" }))
			await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3))
			await waitFor(() => expect(chapterToggle("UI")).toHaveAttribute("aria-expanded", "false"))
			expect(chapterToggle("Runtime")).toHaveAttribute("aria-expanded", "true")
		})
	})

	it("shows a quiet empty state that offers the whole git diff", async () => {
		mocks.get.mockResolvedValue(response({ ...fixture, chapters: [], support: [], hunks: [], warnings: [] }))
		render(<WalkthroughView onDone={vi.fn()} taskId="task" />)
		const empty = await screen.findByTestId("walkthrough-empty")
		expect(empty).toHaveTextContent("No changes")
		expect(screen.queryByRole("heading", { name: fixture.title })).toBeNull()
		fireEvent.click(within(empty).getByRole("button", { name: "Show the whole git diff" }))
		await waitFor(() => expect(sent(mocks.get, 1)).toEqual({ taskId: "task", scope: "git" }))
	})

	it("shows a loading state while collecting changes", async () => {
		mocks.get.mockReturnValue(new Promise(() => {}))
		render(<WalkthroughView onDone={vi.fn()} taskId="task" />)
		expect(screen.getByTestId("walkthrough-loading")).toHaveTextContent("Collecting changes…")
	})

	it("switches scope with a free reload only", async () => {
		await renderPage()
		fireEvent.click(screen.getByRole("button", { name: "Whole git diff" }))
		await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
		expect(sent(mocks.get, 1)).toEqual({ taskId: "task", scope: "git" })
		await act(async () => {})
		expect(mocks.generate).not.toHaveBeenCalled()
	})

	describe("authored", () => {
		const authoredWalk: ChangeWalkthrough = {
			...fixture,
			scope: "authored",
			source: "authored",
			fingerprint: "auth-1",
			authoredId: "walk-1",
			origin: { label: "GitLab MR !128", url: "https://gitlab.example.com/team/app/-/merge_requests/128" },
			title: "Retry on checkout timeouts",
			hunks: fixture.hunks.map((h) => ({ ...h, external: true })),
		}

		async function renderAuthored() {
			mocks.get.mockResolvedValue(response(authoredWalk))
			render(<WalkthroughView authoredId="walk-1" onDone={vi.fn()} taskId="task" />)
			await screen.findByText("Stop the request waiting")
		}

		it("fetches the stored doc by authoredId and hides the scope switch and Generate", async () => {
			await renderAuthored()
			expect(sent(mocks.get)).toEqual({ taskId: "task", scope: "authored", authoredId: "walk-1" })
			expect(screen.queryByTestId("walkthrough-toolbar")).toBeNull()
			expect(screen.queryByRole("group", { name: "Scope" })).toBeNull()
			expect(screen.queryByRole("button", { name: /Generate$/ })).toBeNull()
			expect(screen.getByRole("heading", { name: "Retry on checkout timeouts" })).toBeVisible()
			expect(screen.getByTestId("walkthrough-progress")).toHaveTextContent("0 / 3 stops reviewed")
		})

		it("shows the origin as a link that opens externally", async () => {
			await renderAuthored()
			const origin = screen.getByTestId("walkthrough-origin")
			expect(origin).toHaveTextContent("GitLab MR !128")
			fireEvent.click(origin)
			expect(mocks.openUrl).toHaveBeenCalledTimes(1)
			expect(mocks.openUrl.mock.calls[0][0]).toEqual({ value: authoredWalk.origin?.url })
		})

		it("shows a label-only chip when the origin has no URL", async () => {
			mocks.get.mockResolvedValue(response({ ...authoredWalk, origin: { label: "A pasted diff" } }))
			render(<WalkthroughView authoredId="walk-1" onDone={vi.fn()} taskId="task" />)
			await screen.findByText("Stop the request waiting")
			const origin = screen.getByTestId("walkthrough-origin")
			expect(origin).toHaveTextContent("A pasted diff")
			expect(origin.tagName).not.toBe("BUTTON")
		})

		it("offers no Open diff or Revert anywhere, but keeps notes and marks", async () => {
			const { onDone } = await (async () => {
				const onDone = vi.fn()
				mocks.get.mockResolvedValue(response(authoredWalk))
				render(<WalkthroughView authoredId="walk-1" onDone={onDone} taskId="task" />)
				await screen.findByText("Stop the request waiting")
				return { onDone }
			})()
			expect(screen.queryByRole("button", { name: "Open diff" })).toBeNull()
			expect(screen.queryByRole("button", { name: "Revert file" })).toBeNull()
			expect(screen.queryByRole("button", { name: "Revert hunk" })).toBeNull()

			const first = stop("Stop the request waiting")
			fireEvent.click(within(first).getByRole("button", { name: "Mark reviewed" }))
			fireEvent.click(within(first).getByRole("button", { name: "Add note" }))
			fireEvent.change(within(first).getByLabelText("Note on Stop the request waiting"), {
				target: { value: "Back off on 429s too?" },
			})
			fireEvent.click(within(first).getByRole("button", { name: "Done" }))
			fireEvent.click(screen.getByRole("button", { name: "Send to thread" }))
			await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
			expect(sent(mocks.send)).toEqual({
				taskId: "task",
				scope: "authored",
				authoredId: "walk-1",
				fingerprint: "auth-1",
				stopNotes: { s1: "Back off on 429s too?" },
				overallNote: undefined,
			})
		})

		it("keys review state by authoredId as well as fingerprint", async () => {
			await renderAuthored()
			fireEvent.click(within(stop("Cap at 10k rows")).getByRole("button", { name: "Mark reviewed" }))
			const stored = () => JSON.parse(localStorage.getItem(reviewStorageKey("task", "authored", "walk-1")) ?? "{}")
			expect(stored()["auth-1"].authored.reviewed).toEqual({ s2: true })
			expect(localStorage.getItem(reviewStorageKey("task", "thread"))).toBeNull()
		})
	})
})
