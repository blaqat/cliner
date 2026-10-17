import type { ChangeWalkthrough } from "@shared/Walkthrough"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import WalkthroughView from "./WalkthroughView"

const mocks = vi.hoisted(() => ({ get: vi.fn(), generate: vi.fn(), revert: vi.fn(), send: vi.fn(), open: vi.fn() }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfigProfiles: [{ id: "profile", name: "Review profile" }],
		currentTaskItem: { id: "task", title: "Thread", taskGroupId: "group" },
		taskGroups: [{ id: "group", title: "Task" }],
		navigateToTaskGroup: vi.fn(),
	}),
}))
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

const walk: ChangeWalkthrough = {
	version: 1,
	taskId: "task",
	scope: "thread",
	fingerprint: "fingerprint",
	source: "fallback",
	title: "Change walkthrough",
	focus: "",
	warnings: [],
	support: [],
	chapters: [
		{
			id: "c1",
			title: "Turn 1",
			stops: [{ id: "s1", title: "Validate parser input", prose: "Reject empty inputs.", hunkIds: ["h1"] }],
		},
	],
	hunks: [
		{
			id: "h1",
			fingerprint: "hunk",
			fileId: "file",
			path: "api/parser.ts",
			header: "@@ -1,1 +1,1 @@",
			patch: "-old\n+new",
			oldStart: 1,
			newStart: 1,
		},
	],
}
beforeEach(() => {
	vi.clearAllMocks()
	mocks.get.mockResolvedValue({ value: JSON.stringify(walk) })
	mocks.generate.mockResolvedValue({ value: JSON.stringify({ ...walk, source: "generated" }) })
	mocks.revert.mockResolvedValue({ value: JSON.stringify({ ...walk, chapters: [], hunks: [] }) })
	mocks.send.mockResolvedValue({})
	mocks.open.mockResolvedValue({})
})

describe("minimal walkthrough page", () => {
	it("opens the free breadcrumb page and generates only after an explicit click with a chosen profile", async () => {
		render(<WalkthroughView onDone={vi.fn()} taskId="task" />)
		expect(await screen.findByText("Validate parser input")).toBeVisible()
		expect(screen.getByRole("navigation")).toHaveTextContent("Task › Thread › Walkthrough")
		expect(mocks.generate).not.toHaveBeenCalled()
		fireEvent.change(screen.getByLabelText("Profile"), { target: { value: "profile" } })
		fireEvent.click(screen.getByRole("button", { name: "Generate" }))
		await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1))
		expect(JSON.parse(mocks.generate.mock.calls[0][0].value)).toMatchObject({
			taskId: "task",
			scope: "thread",
			profileId: "profile",
		})
	})
	it("keeps a note visible on a reviewed stop and sends all notes as one RPC", async () => {
		const done = vi.fn()
		render(<WalkthroughView onDone={done} taskId="task" />)
		await screen.findByText("Validate parser input")
		fireEvent.click(screen.getByRole("button", { name: "Add a test for this." }))
		fireEvent.click(screen.getByLabelText("Reviewed"))
		expect(screen.getByLabelText("Add note")).toHaveValue("Add a test for this.")
		fireEvent.change(screen.getByLabelText("Overall note"), { target: { value: "Check the error path." } })
		fireEvent.click(screen.getByRole("button", { name: "Send to thread" }))
		await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
		expect(mocks.send).toHaveBeenCalledTimes(1)
		expect(JSON.parse(mocks.send.mock.calls[0][0].value)).toMatchObject({
			fingerprint: "fingerprint",
			stopNotes: { s1: "Add a test for this." },
			overallNote: "Check the error path.",
		})
	})
	it("requires inline confirmation before a hunk revert", async () => {
		render(<WalkthroughView onDone={vi.fn()} taskId="task" />)
		await screen.findByText("Validate parser input")
		fireEvent.click(screen.getByRole("button", { name: "Revert hunk" }))
		expect(mocks.revert).not.toHaveBeenCalled()
		expect(screen.getByRole("alert")).toHaveTextContent("Revert this hunk?")
		fireEvent.click(screen.getByRole("button", { name: "Confirm revert" }))
		await waitFor(() => expect(mocks.revert).toHaveBeenCalledTimes(1))
		expect(JSON.parse(mocks.revert.mock.calls[0][0].value)).toMatchObject({ hunkId: "h1", confirmed: true })
	})
	it("switches scopes without calling Generate and opens diffs using host file IDs", async () => {
		render(<WalkthroughView onDone={vi.fn()} taskId="task" />)
		await screen.findByText("Validate parser input")
		fireEvent.click(screen.getByRole("button", { name: "Open diff" }))
		await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))
		expect(JSON.parse(mocks.open.mock.calls[0][0].value).fileId).toBe("file")
		await waitFor(() => expect(screen.getByLabelText("Scope")).not.toBeDisabled())
		fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "git" } })
		await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
		expect(JSON.parse(mocks.get.mock.calls[1][0].value).scope).toBe("git")
		expect(mocks.generate).not.toHaveBeenCalled()
	})
})
