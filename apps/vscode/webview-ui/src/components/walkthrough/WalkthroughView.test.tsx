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
		{ id: "fast", name: "Fast", provider: "anthropic", modelId: "haiku" },
		{ id: "deep", name: "Deep", provider: "anthropic", modelId: "opus" },
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
		fireEvent.click(within(first).getByRole("button", { name: "✎ Add note" }))
		fireEvent.click(within(first).getByRole("button", { name: "Add a test for this" }))
		expect(within(first).getByLabelText("Note on Stop the request waiting")).toHaveValue("Add a test for this.")
		fireEvent.click(within(first).getByRole("button", { name: "Done" }))
		expect(within(first).getByText("Add a test for this.")).toBeVisible()

		fireEvent.click(within(first).getByRole("button", { name: "✎ Edit note" }))
		fireEvent.change(within(first).getByLabelText("Note on Stop the request waiting"), {
			target: { value: "Should the job id be a UUID?" },
		})
		fireEvent.click(within(first).getByRole("button", { name: "Done" }))

		fireEvent.click(within(first).getByRole("button", { name: "Mark reviewed" }))
		expect(within(first).getByRole("button", { name: "✓ Reviewed" })).toBeVisible()
		expect(within(first).getByText("Should the job id be a UUID?")).toBeVisible()
		expect(screen.getByTestId("walkthrough-progress")).toHaveTextContent("1 / 3 stops reviewed")

		fireEvent.click(screen.getByRole("button", { name: "✎ Add a note on the whole change" }))
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
		fireEvent.click(within(first).getByRole("button", { name: "✎ Add note" }))
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
		fireEvent.click(within(first).getByRole("button", { name: "✎ Add note" }))
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
		expect(screen.getByTestId("walkthrough-generate-cost")).toHaveTextContent("One call to Deep · only when you click")

		fireEvent.click(screen.getByRole("button", { name: "Choose Generate profile" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: /Fast/ }))
		expect(mocks.generate).not.toHaveBeenCalled()
		expect(screen.getByTestId("walkthrough-generate-cost")).toHaveTextContent("One call to Fast")

		fireEvent.click(screen.getByRole("button", { name: /Generate$/ }))
		await waitFor(() => expect(screen.getByTestId("walkthrough-source")).toHaveTextContent("Generated · Fast"))
		expect(mocks.generate).toHaveBeenCalledTimes(1)
		expect(sent(mocks.generate)).toMatchObject({ taskId: "task", scope: "thread", profileId: "fast", regenerate: false })

		fireEvent.click(screen.getByRole("button", { name: /Regenerate$/ }))
		await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2))
		expect(sent(mocks.generate, 1)).toMatchObject({ profileId: "fast", regenerate: true })
	})

	it("shows Generate failures inline and keeps the free walkthrough", async () => {
		mocks.generate.mockRejectedValue(new Error("Choose a saved API profile for Generate"))
		await renderPage()
		fireEvent.click(screen.getByRole("button", { name: /Generate$/ }))
		expect(await screen.findByRole("alert")).toHaveTextContent("Choose a saved API profile for Generate")
		expect(sent(mocks.generate).profileId).toBe("deep")
		expect(screen.getByTestId("walkthrough-source")).toHaveTextContent("From turns")
	})

	it("switches scope with a free reload only", async () => {
		await renderPage()
		fireEvent.click(screen.getByRole("button", { name: "Whole git diff" }))
		await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
		expect(sent(mocks.get, 1)).toEqual({ taskId: "task", scope: "git" })
		await act(async () => {})
		expect(mocks.generate).not.toHaveBeenCalled()
	})
})
