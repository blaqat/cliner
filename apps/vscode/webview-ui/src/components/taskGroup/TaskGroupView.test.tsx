import { GetTaskGroupResponse } from "@shared/proto/cline/task_group"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { setAutomationRunsForTest } from "@/hooks/useAutomationRuns"
import { getComposerPageTaskGroup, getComposerTaskGroup, setComposerTaskGroup } from "./composerTaskGroup"
import { orderTimeline, TaskGroupView } from "./TaskGroupView"
import { consumeNewNoteRequest, consumeOpenNoteRequest } from "./useTaskGroup"

const mocks = vi.hoisted(() => ({
	getTaskGroup: vi.fn(),
	updateTaskGroup: vi.fn(),
	deleteTaskGroup: vi.fn(),
	previewTaskGroupDelete: vi.fn(),
	deleteTaskGroupWithThreads: vi.fn(),
	toggleTaskSettled: vi.fn(),
	openNote: vi.fn(),
	showTaskWithId: vi.fn(),
	state: {} as Record<string, unknown>,
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
const nav = vi.hoisted(() => ({ value: undefined as { navigate: ReturnType<typeof vi.fn> } | undefined }))
vi.mock("@/components/navigation/NavigationHistoryContext", () => ({ useNavigationHistory: () => nav.value }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		getTaskGroup: (request: unknown) => mocks.getTaskGroup(request),
		updateTaskGroup: (request: unknown) => mocks.updateTaskGroup(request),
		deleteTaskGroup: (request: unknown) => mocks.deleteTaskGroup(request),
		openNote: (request: unknown) => mocks.openNote(request),
	},
	TaskGroupDeleteServiceClient: {
		previewTaskGroupDelete: (request: unknown) => mocks.previewTaskGroupDelete(request),
		deleteTaskGroupWithThreads: (request: unknown) => mocks.deleteTaskGroupWithThreads(request),
	},
	TaskServiceClient: {
		showTaskWithId: (request: unknown) => mocks.showTaskWithId(request),
		toggleTaskSettled: (request: unknown) => mocks.toggleTaskSettled(request),
	},
	AutomationServiceClient: { subscribeToAutomationRuns: () => () => {} },
	WorktreeServiceClient: { threadWorktreeAction: async () => ({ json: '{"summary":{"changedFiles":0,"commits":0}}' }) },
}))

const NOW = 10 * 86_400_000
const HOUR = 3_600_000

const note = (slug: string, name: string, updatedAt: number, extra = {}) => ({
	slug,
	name,
	description: `${name} description`,
	size: 1200,
	updatedAt,
	updatedBy: { kind: "user", threadId: "", threadTitle: "" },
	readers: 0,
	...extra,
})

const FIXTURE = GetTaskGroupResponse.fromPartial({
	group: {
		id: "g1",
		title: "Bulk invoice export",
		tags: [
			{ kind: "ticket", value: "PROJ-482", source: "auto" },
			{ kind: "label", value: "invoices", source: "user" },
		],
		createdAt: 1,
		updatedAt: 2,
		noteCount: 5,
	},
	notes: [
		note("ticket-brief", "Ticket brief", NOW - 48 * HOUR),
		note("codebase-map", "Codebase map", NOW - 47 * HOUR),
		note("dev-plan", "Dev plan", NOW - 24 * HOUR),
		note("decisions", "Decisions", NOW - 3 * HOUR),
		note("review-checklist", "Review checklist", NOW - HOUR),
	],
	threads: [
		{
			threadId: "refine",
			title: "",
			task: "Refine ticket",
			ts: NOW - 47 * HOUR,
			startedTs: NOW - 48 * HOUR,
			read: [],
			wrote: ["ticket-brief"],
		},
		{
			// Created last but active long ago: order is by creation, not activity.
			threadId: "impl",
			title: "Implement steps 1–2",
			task: "first message",
			ts: NOW - 2 * 60_000,
			startedTs: NOW - 3 * HOUR,
			read: ["dev-plan", "codebase-map"],
			wrote: [],
		},
		{
			threadId: "plan",
			title: "Dev plan",
			task: "Plan it",
			ts: NOW - HOUR,
			startedTs: NOW - 24 * HOUR,
			read: ["ticket-brief"],
			wrote: ["dev-plan"],
		},
		{
			threadId: "aside-late",
			title: "",
			task: "Aside: edge cases",
			ts: NOW - 5 * 60_000,
			startedTs: NOW - 10 * HOUR,
			parentTaskId: "plan",
			read: [],
			wrote: [],
		},
		{
			threadId: "aside-early",
			title: "",
			task: "Aside: naming",
			ts: NOW - 20 * HOUR,
			startedTs: NOW - 23 * HOUR,
			parentTaskId: "plan",
			read: [],
			wrote: [],
		},
		{
			threadId: "sub",
			title: "",
			task: "subagent work",
			ts: NOW,
			startedTs: NOW - 60_000,
			isSubagent: true,
			parentTaskId: "impl",
			read: [],
			wrote: [],
		},
	],
})

const renderView = async () => {
	const result = render(<TaskGroupView now={NOW} taskGroupId="g1" />)
	await screen.findByTestId("task-group-counts")
	return result
}

describe("TaskGroupView", () => {
	it("shows this task's automation runs above the notebook, newest open, and their outputs", async () => {
		const run = (id: string, taskGroupId: string, status: "running" | "done") => ({
			id,
			automation: "review",
			title: `Review ${id}`,
			values: {},
			taskGroupId,
			status,
			startedAt: NOW - HOUR,
			...(status === "done" ? { endedAt: NOW } : {}),
			steps: [
				{
					id: "s",
					kind: "thread" as const,
					title: "Review it",
					status: status === "done" ? ("done" as const) : ("running" as const),
					threads: [
						{
							id: "s",
							threadId: `thread-${id}`,
							title: "Review it",
							model: "Opus",
							level: "",
							mode: "ask" as const,
							worktree: false,
							status: status === "done" ? ("done" as const) : ("running" as const),
							reply: "Looks good",
						},
					],
				},
			],
		})
		setAutomationRunsForTest([run("old", "g1", "done"), run("other", "g2", "running"), run("new", "g1", "done")])
		await renderView()
		const section = screen.getByTestId("task-group-runs")
		expect(section).toHaveTextContent("Automations · 2")
		expect(section).not.toHaveTextContent("Review other")
		expect(screen.getByTestId("run-steps-new")).toBeInTheDocument()
		expect(screen.queryByTestId("run-steps-old")).not.toBeInTheDocument()
		// The reply is on its step; Ready for review only lists what to look at.
		expect(screen.getByTestId("run-steps-new")).toHaveTextContent("Looks good")
		expect(await screen.findByTestId("review-nothing-new")).toBeInTheDocument()
		setAutomationRunsForTest([])
	})

	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.getTaskGroup.mockReset().mockResolvedValue(FIXTURE)
		mocks.updateTaskGroup.mockReset().mockResolvedValue({})
		mocks.deleteTaskGroup.mockReset().mockResolvedValue({})
		mocks.previewTaskGroupDelete.mockReset().mockResolvedValue({
			threads: ["t1", "t2", "t3", "t4", "t5"].map((id) => ({
				id,
				title: id,
				worktreeNote: "",
				worktreeLosses: 0,
				subagents: 0,
			})),
		})
		mocks.deleteTaskGroupWithThreads.mockReset().mockResolvedValue({ deleted: true, blocked: "" })
		mocks.toggleTaskSettled.mockReset().mockResolvedValue({})
		mocks.openNote.mockReset().mockResolvedValue({})
		mocks.showTaskWithId.mockReset().mockResolvedValue({})
		mocks.state = {
			taskGroups: [],
			sessionStatuses: { impl: "running" },
			currentBranch: "feature/PROJ-482-bulk-export",
			hideTaskGroupView: vi.fn(),
			navigateToTaskGroup: vi.fn(),
		}
		act(() => setComposerTaskGroup(undefined))
		consumeNewNoteRequest()
	})

	it("renders the breadcrumb, title, counts and tags from getTaskGroup", async () => {
		await renderView()
		expect(mocks.getTaskGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }))
		expect(screen.getByTestId("task-group-header")).toHaveTextContent("Bulk invoice export")
		expect(screen.getByTestId("crumb-home")).toBeInTheDocument()
		// The name lives in the breadcrumb only, with the task icon, like a thread's.
		expect(screen.getByTestId("task-header-title")).toHaveTextContent("Bulk invoice export")
		expect(screen.getByTestId("task-header-title").querySelector(".codicon-tasklist")).not.toBeNull()
		expect(screen.queryByRole("heading", { name: "Bulk invoice export" })).toBeNull()
		// Subagents belong to their root thread and aren't counted.
		expect(screen.getByTestId("task-group-counts")).toHaveTextContent("5 threads · 5 notes")
		const tags = screen.getAllByTestId("task-tag-chip").map((chip) => chip.textContent)
		expect(tags).toEqual(["PROJ-482×", "invoices×"])
	})

	it("fixes the composer's task pill to this task while open", async () => {
		const { unmount } = render(<TaskGroupView now={NOW} taskGroupId="g1" />)
		await screen.findByTestId("task-group-counts")
		expect(getComposerPageTaskGroup()).toBe("g1")
		// The page scope isn't the clearable pill pick, so sends can't drop it.
		expect(getComposerTaskGroup()).toBeUndefined()
		unmount()
		expect(getComposerPageTaskGroup()).toBeUndefined()
	})

	it("shows the 4 newest notes in the grid and opens a note on click", async () => {
		await renderView()
		const cards = screen.getAllByTestId("task-group-note-card")
		expect(cards.map((card) => card.querySelector(".font-semibold")?.textContent)).toEqual([
			"Review checklist",
			"Decisions",
			"Dev plan",
			"Codebase map",
		])
		expect(cards[0]).toHaveTextContent("1.2 KB")
		fireEvent.click(cards[1])
		// Notes open on the notebook page, in the doc editor, not as a file.
		expect(mocks.state.navigateToTaskGroup).toHaveBeenCalledWith("g1", "notebook")
		expect(consumeOpenNoteRequest()).toBe("decisions")
		expect(mocks.openNote).not.toHaveBeenCalled()
	})

	it("names the folder of a thread running outside what's open", async () => {
		mocks.state.workspaceRoots = [{ path: "/work/here" }]
		mocks.state.platform = "darwin"
		const [first, second] = FIXTURE.threads
		mocks.state.taskHistory = [
			{ id: first.threadId, cwdOnTaskInitialization: "/work/other" },
			{ id: second.threadId, cwdOnTaskInitialization: "/work/here/app" },
		]
		await renderView()
		const tags = screen.getAllByTestId("thread-cwd-tag")
		expect(tags.map((tag) => tag.textContent)).toEqual(["other"])
	})

	it("＋ New and View all › open the notebook page", async () => {
		await renderView()
		const navigate = mocks.state.navigateToTaskGroup as ReturnType<typeof vi.fn>
		fireEvent.click(screen.getByRole("button", { name: "View all ›" }))
		expect(navigate).toHaveBeenCalledWith("g1", "notebook")
		expect(consumeNewNoteRequest()).toBe(false)
		fireEvent.click(screen.getByRole("button", { name: "＋ New" }))
		expect(navigate).toHaveBeenCalledTimes(2)
		expect(consumeNewNoteRequest()).toBe(true)
	})

	it("opens a timeline thread through the history layer, so Back returns to the task", async () => {
		nav.value = { navigate: vi.fn() }
		try {
			await renderView()
			fireEvent.click(screen.getAllByTestId("task-group-timeline-row")[0])
			expect(nav.value.navigate).toHaveBeenCalledWith({ kind: "thread", id: expect.any(String) })
			// No direct open: that path passes through home and Back would land there.
			expect(mocks.showTaskWithId).not.toHaveBeenCalled()
		} finally {
			nav.value = undefined
		}
	})

	it("tells the task's story oldest first, subthreads right after their parent, with chips", async () => {
		await renderView()
		const rows = screen.getAllByTestId("task-group-timeline-row")
		expect(rows.map((row) => row.textContent?.replace(/\s+/g, " "))).toEqual([
			expect.stringContaining("Refine ticket"),
			expect.stringContaining("Dev plan"),
			expect.stringContaining("Subthread: Aside: naming"),
			expect.stringContaining("Subthread: Aside: edge cases"),
			expect.stringContaining("Implement steps 1–2"),
		])
		const entries = screen.getAllByTestId("task-group-timeline-entry")
		expect(entries.map((entry) => entry.hasAttribute("data-subthread"))).toEqual([false, false, true, true, false])
		// The age is when the thread started (the order), not its last activity.
		expect(rows[4]).toHaveTextContent("3h")
		expect(rows[4]).toHaveAttribute("title", "Started 3h ago · last active 2m ago")
		expect(within(rows[4]).getByRole("img", { name: "Running" })).toBeInTheDocument()
		expect(within(rows[0]).getByRole("img", { name: "Done" })).toBeInTheDocument()

		const planChips = rows[1].querySelectorAll(".codicon-edit, .codicon-eye")
		expect(
			[...planChips].map((icon) => [icon.className.includes("edit") ? "wrote" : "read", icon.nextSibling?.textContent]),
		).toEqual([
			["wrote", "Dev plan"],
			["read", "Ticket brief"],
		])
		// The legend is icons only.
		const legend = screen.getByTestId("task-group-legend")
		expect(legend.textContent).toBe("")
		expect(within(legend).getByRole("img", { name: "Wrote" })).toBeInTheDocument()
		expect(within(legend).getByRole("img", { name: "Read" })).toBeInTheDocument()

		fireEvent.click(rows[4])
		expect(mocks.state.hideTaskGroupView).toHaveBeenCalled()
		expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "impl" }))
	})

	it("marks a thread waiting on its subagents with its own icon and tooltip", async () => {
		mocks.state = {
			...mocks.state,
			sessionStatuses: { impl: "done", sub: "running" },
			taskHistory: [
				{ id: "impl", ts: NOW, task: "Implement", tokensIn: 0, tokensOut: 0, totalCost: 0 },
				{
					id: "sub",
					ts: NOW,
					task: "sub",
					parentTaskId: "impl",
					isSubagent: true,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			],
		}
		await renderView()
		const rows = screen.getAllByTestId("task-group-timeline-row")
		const icon = within(rows[4]).getByRole("img", { name: "Waiting on 1 subagent" })
		expect(icon).toHaveAttribute("data-status", "subagents")
		expect(icon).toHaveClass("size-3")
		expect(within(rows[0]).getByRole("img", { name: "Done" })).toBeInTheDocument()
	})

	it("draws the connector only between the first and last nodes", async () => {
		await renderView()
		const entries = screen.getAllByTestId("task-group-timeline-entry")
		const spine = (entry: HTMLElement) =>
			[...entry.querySelectorAll<HTMLElement>(":scope > span[aria-hidden]")].map((line) => line.className)
		// First entry: only the segment below its node.
		expect(spine(entries[0])).toEqual([expect.stringContaining("bottom-0")])
		expect(spine(entries[0])[0]).not.toContain("top-0")
		// A subthread branches off with an elbow and the spine continues below.
		expect(spine(entries[2])).toEqual([expect.stringContaining("border-l"), expect.stringContaining("bottom-0")])
		// Last entry: only the segment above its node.
		expect(spine(entries[4])).toEqual([expect.stringContaining("top-0")])
		expect(spine(entries[4])[0]).not.toContain("bottom-0")
	})

	it("ends the spine at a trailing subthread's elbow", async () => {
		mocks.getTaskGroup.mockResolvedValue(
			GetTaskGroupResponse.fromPartial({
				...FIXTURE,
				threads: FIXTURE.threads.filter((thread) => thread.threadId === "plan" || thread.threadId === "aside-late"),
			}),
		)
		await renderView()
		const entries = screen.getAllByTestId("task-group-timeline-entry")
		expect(entries).toHaveLength(2)
		const last = [...entries[1].querySelectorAll<HTMLElement>(":scope > span[aria-hidden]")]
		expect(last.map((line) => line.className)).toEqual([expect.stringContaining("border-l")])
	})

	it("Link branch adds the current branch as a tag, never automatically", async () => {
		await renderView()
		expect(mocks.updateTaskGroup).not.toHaveBeenCalled()
		expect(screen.getByTestId("task-group-branch-hint")).toHaveTextContent(
			"Current branch feature/PROJ-482-bulk-export isn’t linked",
		)
		fireEvent.click(screen.getByRole("button", { name: "Link branch" }))
		expect(mocks.updateTaskGroup).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "g1",
				tags: {
					tags: [
						{ kind: "ticket", value: "PROJ-482", source: "auto" },
						{ kind: "label", value: "invoices", source: "user" },
						{ kind: "branch", value: "feature/PROJ-482-bulk-export", source: "user" },
					],
				},
			}),
		)
		expect(screen.queryByTestId("task-group-branch-hint")).toBeNull()
	})

	it("dismisses the branch hint for this task and branch, and it stays dismissed", async () => {
		const stored = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => stored.set(key, value),
		})
		const { unmount } = await renderView()
		fireEvent.click(screen.getByTestId("task-group-branch-hint-dismiss"))
		expect(screen.queryByTestId("task-group-branch-hint")).toBeNull()
		expect(mocks.updateTaskGroup).not.toHaveBeenCalled()
		unmount()
		await renderView()
		expect(screen.queryByTestId("task-group-branch-hint")).toBeNull()
		expect(JSON.parse(stored.get("cline.taskBranchHintDismissed") ?? "[]")).toEqual(["g1\nfeature/PROJ-482-bulk-export"])
		vi.unstubAllGlobals()
	})

	it("＋ tag adds a typed tag and × removes one", async () => {
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "＋ tag" }))
		const input = screen.getByLabelText("New tag")
		fireEvent.change(input, { target: { value: "PROJ-490" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(mocks.updateTaskGroup).toHaveBeenLastCalledWith(
			expect.objectContaining({
				tags: { tags: expect.arrayContaining([{ kind: "ticket", value: "PROJ-490", source: "user" }]) },
			}),
		)
		fireEvent.click(screen.getByRole("button", { name: "Remove tag invoices" }))
		const lastTags = mocks.updateTaskGroup.mock.lastCall?.[0].tags.tags
		expect(lastTags.map((tag: { value: string }) => tag.value)).toEqual(["PROJ-482", "PROJ-490"])
	})

	it("renames from the breadcrumb's ✎ or ⋯ › Rename task (Enter saves, Esc cancels)", async () => {
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "Rename task" }))
		let input = screen.getByLabelText("Task title")
		fireEvent.change(input, { target: { value: "Nope" } })
		fireEvent.keyDown(input, { key: "Escape" })
		expect(mocks.updateTaskGroup).not.toHaveBeenCalled()
		expect(screen.getByTestId("task-header-title")).toHaveTextContent("Bulk invoice export")

		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename task" }))
		input = screen.getByLabelText("Task title")
		fireEvent.change(input, { target: { value: "Bulk export v2" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(mocks.updateTaskGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "g1", title: "Bulk export v2" }))
		expect(screen.getByTestId("task-header-title")).toHaveTextContent("Bulk export v2")
	})

	it("deletes through an inline confirm row, not a modal", async () => {
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: /Delete task/ }))
		const confirm = screen.getByTestId("task-group-delete-confirm")
		await waitFor(() => expect(confirm).toHaveTextContent("keep its 5 threads (they stay, just unfiled)"))
		expect(screen.queryByRole("dialog")).toBeNull()
		expect(screen.queryByRole("alertdialog")).toBeNull()

		fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }))
		expect(screen.queryByTestId("task-group-delete-confirm")).toBeNull()
		expect(mocks.deleteTaskGroup).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: /Delete task/ }))
		const only = await within(screen.getByTestId("task-group-delete-confirm")).findByRole("button", {
			name: "Delete task only (keep threads)",
		})
		fireEvent.click(only)
		expect(mocks.deleteTaskGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }))
		expect(mocks.deleteTaskGroupWithThreads).not.toHaveBeenCalled()
		await waitFor(() => expect(mocks.state.hideTaskGroupView).toHaveBeenCalled())
	})

	it("settles or unsettles one thread or aside from its timeline row", async () => {
		const thread = (id: string, extra = {}) => ({ id, ts: 1, task: id, taskGroupId: "g1", ...extra })
		mocks.state = {
			...mocks.state,
			sessionStatuses: {},
			taskHistory: [thread("refine", { isSettled: true }), thread("plan"), thread("aside-late", { parentTaskId: "plan" })],
		}
		await renderView()
		const entries = screen.getAllByTestId("task-group-timeline-entry")
		const entry = (name: string) => entries.find((el) => el.textContent?.includes(name)) as HTMLElement

		expect(entry("Refine ticket")).toHaveAttribute("data-settled", "true")
		fireEvent.click(within(entry("Refine ticket")).getByRole("button", { name: "Unsettle Refine ticket" }))
		fireEvent.click(within(entry("Dev plan")).getByRole("button", { name: "Settle Dev plan" }))
		fireEvent.click(within(entry("Aside: edge cases")).getByRole("button", { name: "Settle Aside: edge cases" }))
		expect(mocks.toggleTaskSettled.mock.calls.map(([request]) => request.taskId)).toEqual(["refine", "plan", "aside-late"])
		expect(screen.getAllByTestId("task-group-timeline-settle")).toHaveLength(entries.length)
	})

	it("settles every idle thread from the ⋯ menu and reports the running one", async () => {
		const thread = (id: string, extra = {}) => ({ id, ts: 1, task: id, taskGroupId: "g1", ...extra })
		mocks.state = {
			...mocks.state,
			taskHistory: [
				thread("refine", { isSettled: true }),
				thread("impl"),
				thread("plan"),
				thread("aside-late", { parentTaskId: "plan" }),
				thread("sub", { isSubagent: true, parentTaskId: "impl" }),
				{ id: "elsewhere", ts: 1, task: "x", taskGroupId: "other" },
			],
		}
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: "Settle all" }))

		const notice = await screen.findByTestId("task-group-settle-notice")
		// impl is running: skipped. refine was already settled; the subagent and other task's thread are not counted.
		expect(notice).toHaveTextContent("Settled 2 · 1 still running")
		expect(mocks.toggleTaskSettled.mock.calls.flatMap(([request]) => request.taskIds)).toEqual(["plan", "aside-late"])
		fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }))
		expect(screen.queryByTestId("task-group-settle-notice")).toBeNull()
	})

	it("offers Unsettle all when every thread is settled", async () => {
		mocks.state = {
			...mocks.state,
			sessionStatuses: {},
			taskHistory: [
				{ id: "a", ts: 1, task: "a", taskGroupId: "g1", isSettled: true },
				{ id: "b", ts: 1, task: "b", taskGroupId: "g1", isSettled: true },
			],
		}
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: "Unsettle all" }))
		await waitFor(() => expect(mocks.toggleTaskSettled).toHaveBeenCalledTimes(1))
		expect(await screen.findByTestId("task-group-settle-notice")).toHaveTextContent("Unsettled 2")
	})

	it("says why a ⋯ row is greyed out and sets Delete apart", async () => {
		mocks.state = { ...mocks.state, sessionStatuses: {}, taskHistory: [] }
		mocks.getTaskGroup.mockResolvedValue(GetTaskGroupResponse.fromPartial({ ...FIXTURE, threads: [] }))
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		const settle = screen.getByRole("menuitem", { name: "Settle all" })
		expect(settle).toBeDisabled()
		expect(settle).toHaveAccessibleDescription("No threads yet.")
		const save = screen.getByRole("menuitem", { name: "Save as an automation…" })
		expect(save).toBeDisabled()
		expect(save).toHaveAccessibleDescription("Start a thread first: its prompt becomes step 1.")
		// Delete sits below a divider, in the error color.
		const remove = screen.getByRole("menuitem", { name: "Delete task…" })
		expect(remove.previousElementSibling?.tagName).toBe("HR")
		expect(remove.className).toContain("text-error")
	})

	it("can't settle while every open thread is still running, and says so", async () => {
		mocks.state = {
			...mocks.state,
			sessionStatuses: { a: "running" },
			taskHistory: [{ id: "a", ts: 1, task: "a", taskGroupId: "g1" }],
		}
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		expect(screen.getByRole("menuitem", { name: "Settle all" })).toHaveAccessibleDescription(
			"1 thread still running; settle when it stops.",
		)
	})

	it("moves through the ⋯ menu with the arrow keys, skipping greyed-out rows", async () => {
		mocks.state = { ...mocks.state, sessionStatuses: {}, taskHistory: [] }
		mocks.getTaskGroup.mockResolvedValue(GetTaskGroupResponse.fromPartial({ ...FIXTURE, threads: [] }))
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		const rename = screen.getByRole("menuitem", { name: "Rename task" })
		rename.focus()
		fireEvent.keyDown(rename, { key: "ArrowDown" })
		expect(screen.getByRole("menuitem", { name: "Delete task…" })).toHaveFocus()
		fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" })
		expect(screen.getByRole("menuitem", { name: "New worktree for this task" })).toHaveFocus()
		fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" })
		expect(rename).toHaveFocus()
	})

	it("renames from the ⋯ menu", async () => {
		await renderView()
		fireEvent.click(screen.getByRole("button", { name: "Task actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: /Rename task/ }))
		expect(screen.getByLabelText("Task title")).toBeInTheDocument()
	})

	it("home crumb goes back home", async () => {
		await renderView()
		fireEvent.click(screen.getByTestId("crumb-home"))
		expect(mocks.state.hideTaskGroupView).toHaveBeenCalled()
	})

	it("refetches when task group state changes (notebook edits on disk)", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		try {
			const { rerender } = render(<TaskGroupView now={NOW} taskGroupId="g1" />)
			await screen.findByTestId("task-group-counts")
			expect(mocks.getTaskGroup).toHaveBeenCalledTimes(1)
			mocks.state = { ...mocks.state, taskGroups: [] }
			rerender(<TaskGroupView now={NOW} taskGroupId="g1" />)
			mocks.state = { ...mocks.state, taskGroups: [] }
			rerender(<TaskGroupView now={NOW} taskGroupId="g1" />)
			await act(async () => {
				vi.advanceTimersByTime(600)
			})
			// Bursts of state posts coalesce into one refetch.
			expect(mocks.getTaskGroup).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it("updates the timeline when a background thread joins without changing task summaries", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		try {
			const { rerender } = await renderView()
			const added = { threadId: "automation-step", task: "Automation step", ts: NOW, read: [], wrote: [] }
			mocks.getTaskGroup.mockResolvedValue(
				GetTaskGroupResponse.fromPartial({ ...FIXTURE, threads: [...FIXTURE.threads, added] }),
			)
			mocks.state = { ...mocks.state, taskHistory: [{ id: added.threadId, task: added.task, ts: NOW, taskGroupId: "g1" }] }
			rerender(<TaskGroupView now={NOW} taskGroupId="g1" />)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600)
			})
			expect(screen.getByText("Automation step")).toBeInTheDocument()
		} finally {
			vi.useRealTimers()
		}
	})

	it("says so when the task is gone", async () => {
		mocks.getTaskGroup.mockRejectedValue(new Error("Task group not found"))
		render(<TaskGroupView now={NOW} taskGroupId="g1" />)
		expect(await screen.findByText("This task no longer exists.")).toBeInTheDocument()
	})
})

describe("orderTimeline", () => {
	const row = (threadId: string, startedTs: number, parentTaskId?: string) => ({
		threadId,
		task: threadId,
		ts: 0,
		startedTs,
		parentTaskId,
		isSubagent: false,
		read: [],
		wrote: [],
	})

	it("treats a subthread whose parent isn't in the task as a thread, and nests deeper asides", () => {
		const order = orderTimeline([row("b", 2), row("orphan", 1, "elsewhere"), row("b1", 3, "b"), row("b1a", 4, "b1")])
		expect(order.map(({ thread, depth }) => [thread.threadId, depth])).toEqual([
			["orphan", 0],
			["b", 0],
			["b1", 1],
			["b1a", 2],
		])
	})

	it("keeps threads caught in a parent cycle", () => {
		const order = orderTimeline([row("x", 2, "y"), row("y", 1, "x")])
		expect(order.map(({ thread }) => thread.threadId).sort()).toEqual(["x", "y"])
	})
})
