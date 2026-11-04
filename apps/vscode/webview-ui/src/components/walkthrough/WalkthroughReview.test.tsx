import type { ChangeWalkthrough } from "@shared/Walkthrough"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reviewStorageKey } from "./reviewState"
import WalkthroughView from "./WalkthroughView"

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	generate: vi.fn(),
	send: vi.fn(),
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
		revertWalkthroughChange: vi.fn(),
		sendWalkthroughNotes: mocks.send,
		openWalkthroughDiff: vi.fn(),
	},
	UiServiceClient: { openUrl: vi.fn() },
}))

const hunk = (id: string, path: string, patch: string) => ({
	id,
	fingerprint: `fp-${id}`,
	fileId: `file-${path}`,
	path,
	header: patch.split("\n")[0],
	patch,
	oldStart: 1,
	newStart: 1,
})

/** Two stops; stop 1 carries six notes (one nice) so its group shows three and "+2 more". */
const fixture: ChangeWalkthrough = {
	version: 1,
	taskId: "task",
	scope: "thread",
	fingerprint: "diff-1",
	source: "generated",
	profileId: "fast",
	title: "Webhook retries",
	focus: "",
	warnings: [],
	chapters: [
		{
			id: "c1",
			title: "Retries",
			stops: [
				{ id: "s1", title: "Retry loop", prose: "Loops with backoff.", hunkIds: ["h1"] },
				{ id: "s2", title: "Retry limits", prose: "A constant.", hunkIds: ["h2"] },
			],
		},
	],
	support: [],
	hunks: [
		hunk(
			"h1",
			"src/dispatcher.ts",
			"@@ -1,2 +1,3 @@\n context\n-  if (status < 300) return\n+  if (status < 500) return\n+  sleep(backoff(attempt))\n",
		),
		hunk("h2", "src/limits.ts", "@@ -0,0 +1,1 @@\n+export const MAX_TRIES = 5\n"),
	],
	review: {
		summary: "Fix the 4xx retries before merging.",
		notes: [
			{ id: "w1", kind: "suggestion", title: "Test the retry path", text: "No test covers the loop." },
			{ id: "q1", kind: "question", stopId: "s1", title: "Per-hook limit?", text: "Is the limit per customer?" },
			{
				id: "r1",
				kind: "risk",
				severity: "high",
				stopId: "s1",
				hunkId: "h1",
				line: 1,
				endLine: 2,
				title: "Retries 4xx too",
				text: "Retry only 5xx, 408 and 429.",
			},
			{ id: "r2", kind: "risk", stopId: "s1", hunkId: "h1", line: 3, title: "Blocks a worker", text: "Schedule it." },
			{ id: "g1", kind: "suggestion", stopId: "s1", hunkId: "h1", line: 3, title: "Add jitter", text: "±20%." },
			{ id: "g2", kind: "suggestion", stopId: "s1", title: "Name the 300", text: "A helper." },
			{ id: "n1", kind: "nice", stopId: "s1", hunkId: "h1", line: 0, title: "Try number logged", text: "Easy to trace." },
			{ id: "lost", kind: "suggestion", stopId: "s2", hunkId: "h2", line: 9, title: "Parse once", text: "Not here." },
		],
	},
}

const response = (walk: ChangeWalkthrough) => ({ value: JSON.stringify(walk) })
const sent = (fn: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(fn.mock.calls[call][0].value)
const panel = () => screen.getByTestId("review-panel")
const group = (key: string) => panel().querySelector<HTMLElement>(`[data-group="${key}"]`) as HTMLElement
const rowTitles = (element: HTMLElement) =>
	within(element)
		.queryAllByTestId("review-row")
		.map((row) => row.querySelector(".truncate")?.textContent)
const stored = () => JSON.parse(localStorage.getItem(reviewStorageKey("task", "thread")) ?? "{}")["diff-1"] ?? {}

const state = () => ({
	apiConfigProfiles: [{ id: "cfg", name: "Haiku", provider: "anthropic", modelId: "haiku" }],
	profiles: [{ id: "fast", name: "Fast", configurationId: "cfg" }],
	walkthroughGenerateProfileId: "fast",
	currentTaskItem: { id: "task", ts: 1, task: "t", title: "Thread" },
	taskHistory: [],
	taskGroups: [],
	navigateToTaskGroup: vi.fn(),
	navigateToSettings: vi.fn(),
	windowFocused: true,
	clineMessages: [],
})

async function renderPage(walk: ChangeWalkthrough = fixture) {
	mocks.get.mockResolvedValue(response(walk))
	const view = render(<WalkthroughView onDone={vi.fn()} taskId="task" />)
	await screen.findByText("Loops with backoff.")
	return view
}

beforeEach(() => {
	vi.clearAllMocks()
	const storage = new Map<string, string>()
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	})
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	mocks.state = state()
	mocks.generate.mockResolvedValue(response(fixture))
	mocks.send.mockResolvedValue({})
})
afterEach(() => vi.unstubAllGlobals())

describe("Cline's review notes", () => {
	it("lists the summary and notes by stop, whole change first, three per stop then +N more and one nice line", async () => {
		await renderPage()
		expect(panel()).toHaveTextContent("Fix the 4xx retries before merging.")
		const groups = within(panel()).getAllByTestId("review-group")
		expect(groups.map((g) => g.dataset.group)).toEqual(["whole", "s1", "s2"])
		expect(rowTitles(group("whole"))).toEqual(["Test the retry path"])
		// High first, then by kind; nice never takes a top spot.
		expect(rowTitles(group("s1"))).toEqual(["Retries 4xx too", "Blocks a worker", "Per-hook limit?"])
		expect(within(group("s1")).getByTestId("review-high")).toBeTruthy()
		const more = within(group("s1")).getByTestId("review-more")
		expect(more).toHaveTextContent("+2 more · 2 suggestions")
		expect(within(group("s1")).getByTestId("review-nice")).toHaveTextContent("1 nice thing")
		fireEvent.click(more)
		expect(rowTitles(group("s1"))).toHaveLength(5)
		fireEvent.click(within(group("s1")).getByTestId("review-nice"))
		expect(rowTitles(group("s1"))).toContain("Try number logged")
	})

	it("says when a note's line isn't in the diff and keeps it on its stop", async () => {
		await renderPage()
		const row = within(group("s2")).getByTestId("review-row")
		expect(row).toHaveTextContent("Parse once")
		expect(row).toHaveTextContent("line not found")
	})

	it("opens a gutter marker's note under its lines and highlights it in the list", async () => {
		await renderPage()
		expect(screen.queryByTestId("review-callout")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Cline · Risk: Retries 4xx too" }))
		const callout = screen.getByTestId("review-callout")
		expect(callout).toHaveTextContent("Retry only 5xx, 408 and 429.")
		// Under the note's last line (body line 2), not its first.
		expect(callout.previousElementSibling).toHaveAttribute("data-line-index", "2")
		const active = panel().querySelector("[aria-current='true']")
		expect(active).toHaveTextContent("Retries 4xx too")
		// Two notes on one line share a marker, and it opens both; a hidden "+N more" note shows when picked.
		fireEvent.click(screen.getByRole("button", { name: "Cline · Risk: Blocks a worker and 1 more" }))
		expect(screen.getAllByTestId("review-callout")).toHaveLength(3)
		fireEvent.click(screen.getByRole("button", { name: "Cline · Risk: Retries 4xx too" }))
		expect(screen.getAllByTestId("review-callout")).toHaveLength(2)
	})

	it("jumps from the list to the line and opens the note there", async () => {
		await renderPage()
		expect(screen.queryByTestId("review-callout")).toBeNull()
		fireEvent.click(within(group("s1")).getByRole("button", { name: /Go to .*Retries 4xx too/ }))
		expect(screen.getByTestId("review-callout")).toHaveTextContent("Retries 4xx too")
	})

	it("shows stop notes as ✦ N on the stop, and a reviewed stop keeps its count from Cline when folded", async () => {
		await renderPage()
		const card = screen.getByRole("article", { name: "Retry loop" })
		const chip = within(card).getByTestId("walkthrough-stop-cline")
		expect(chip).toHaveTextContent("2")
		fireEvent.click(chip)
		expect(within(card).getByTestId("walkthrough-stop-cline-notes")).toHaveTextContent("Per-hook limit?")
		fireEvent.click(within(card).getByTestId("walkthrough-stop-check"))
		expect(card).toHaveAttribute("data-folded", "true")
		expect(within(card).getByTestId("walkthrough-stop-cline-count")).toHaveTextContent("6 from Cline")
	})

	it("Fix, Reply, Dismiss and Undo update the answers, and only fixes and replies go with Send", async () => {
		await renderPage()
		const send = () => screen.getByRole("button", { name: /^Send/ })
		expect(send()).toBeDisabled()
		expect(screen.getByTestId("walkthrough-send-hint")).toHaveTextContent("Fix, reply or add a note to send")

		fireEvent.click(screen.getByRole("button", { name: "Cline · Risk: Retries 4xx too" }))
		const card = within(screen.getByTestId("review-callout"))
		fireEvent.click(card.getByRole("button", { name: "Fix" }))
		expect(card.getByRole("button", { name: "Fix in Send" })).toHaveAttribute("aria-pressed", "true")
		expect(stored().reviewResponses).toEqual({ r1: { fix: true } })
		expect(send()).toHaveTextContent("Send 1 fix")

		fireEvent.click(card.getByRole("button", { name: "Reply" }))
		fireEvent.change(card.getByRole("textbox", { name: "Reply to Retries 4xx too" }), {
			target: { value: "408 and 429 only" },
		})
		fireEvent.click(card.getByRole("button", { name: "Done" }))
		expect(card.getByTestId("review-reply")).toHaveTextContent("408 and 429 only")
		expect(send()).toHaveTextContent("Send 1 fix, 1 reply")

		// Dismiss folds a note to one line; Undo brings it back.
		fireEvent.click(within(group("whole")).getByRole("button", { name: /Test the retry path/ }))
		fireEvent.click(within(group("whole")).getByRole("button", { name: "Fix" }))
		fireEvent.click(within(group("whole")).getByRole("button", { name: "Dismiss" }))
		expect(within(group("whole")).getByTestId("review-note-dismissed")).toHaveTextContent("Dismissed")
		expect(stored().reviewResponses.w1).toEqual({ fix: true, dismissed: true })
		expect(send()).toHaveTextContent("Send 1 fix, 1 reply")
		fireEvent.click(within(group("whole")).getByRole("button", { name: "Undo" }))
		expect(within(group("whole")).getByRole("group", { name: /Test the retry path/ })).toBeTruthy()
		expect(send()).toHaveTextContent("Send 2 fixes, 1 reply")
		fireEvent.click(within(group("whole")).getByRole("button", { name: "Dismiss" }))

		fireEvent.click(send())
		await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
		expect(sent(mocks.send).reviewResponses).toEqual({ r1: { fix: true, reply: "408 and 429 only" } })
		// Sent answers are cleared; the dismissal stays.
		await waitFor(() => expect(stored().reviewResponses).toEqual({ w1: { dismissed: true } }))
	})

	it("hides all of Cline's notes from the header chip, markers and panel alike", async () => {
		await renderPage()
		expect(screen.getAllByTestId("review-marker").length).toBeGreaterThan(0)
		const chip = screen.getByTestId("review-chip")
		expect(chip).toHaveTextContent("8 from Cline")
		expect(chip).toHaveTextContent("1 high")
		fireEvent.click(chip)
		fireEvent.click(await screen.findByRole("menuitem", { name: "Hide all of Cline's notes" }))
		expect(screen.queryAllByTestId("review-marker")).toHaveLength(0)
		expect(screen.queryByTestId("review-panel")).toBeNull()
		expect(screen.queryByTestId("walkthrough-stop-cline")).toBeNull()
		expect(screen.getByTestId("review-hidden")).toHaveTextContent("8 notes from Cline are hidden.")
		fireEvent.click(screen.getByRole("button", { name: "Show them" }))
		expect(screen.getAllByTestId("review-marker").length).toBeGreaterThan(0)
	})

	it("filters by kind from the chip menu, and says Clear filter when nothing is left", async () => {
		await renderPage()
		fireEvent.click(screen.getByTestId("review-chip"))
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Risk/ }))
		expect(screen.queryByRole("button", { name: /Cline · Risk/ })).toBeNull()
		expect(screen.getByTestId("review-chip")).toHaveTextContent("6 of 8 from Cline")
		for (const kind of ["Question", "Suggestion", "Nice"])
			fireEvent.click(within(panel()).getByRole("button", { name: new RegExp(`^${kind}`) }))
		expect(screen.getByTestId("review-filtered-empty")).toHaveTextContent("All 8 notes are hidden by the filter.")
		fireEvent.click(screen.getByRole("button", { name: "Clear filter" }))
		expect(screen.queryByTestId("review-filtered-empty")).toBeNull()
		expect(within(panel()).getByRole("button", { name: "All 8" })).toHaveAttribute("aria-pressed", "true")
	})

	it("says Cline found nothing to flag when the review is empty", async () => {
		await renderPage({ ...fixture, review: { notes: [] } })
		expect(screen.getByTestId("review-empty")).toHaveTextContent("Cline found nothing to flag")
		expect(screen.queryByTestId("review-chip")).toBeNull()
		expect(screen.getByTestId("walkthrough-send-hint")).toHaveTextContent("Add a note to send")
	})

	it("shows nothing from Cline when the walkthrough has no review", async () => {
		await renderPage({ ...fixture, review: undefined })
		expect(screen.queryByTestId("review-panel")).toBeNull()
		expect(screen.queryAllByTestId("review-marker")).toHaveLength(0)
	})

	it("sends Add review notes with the next Generate only, and doesn't remember it", async () => {
		const view = await renderPage({ ...fixture, source: "fallback", review: undefined })
		fireEvent.click(screen.getByRole("button", { name: "Choose Generate profile" }))
		const option = await screen.findByRole("menuitemcheckbox", { name: /Add review notes/ })
		expect(option).toHaveAttribute("aria-checked", "false")
		fireEvent.click(option)
		expect(option).toHaveAttribute("aria-checked", "true")
		fireEvent.keyDown(option, { key: "Escape" })

		fireEvent.click(screen.getByRole("button", { name: /^Generate/ }))
		await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1))
		expect(sent(mocks.generate).reviewNotes).toBe(true)

		fireEvent.click(await screen.findByRole("button", { name: "Choose Generate profile" }))
		expect(await screen.findByRole("menuitemcheckbox", { name: /Add review notes/ })).toHaveAttribute("aria-checked", "false")
		view.unmount()

		await renderPage({ ...fixture, source: "fallback", review: undefined })
		fireEvent.click(screen.getByRole("button", { name: "Choose Generate profile" }))
		expect(await screen.findByRole("menuitemcheckbox", { name: /Add review notes/ })).toHaveAttribute("aria-checked", "false")
	})
})
