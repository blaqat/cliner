import type { ClineMessage } from "@shared/ExtensionMessage"
import { SKILL_DRAFTS_ID } from "@shared/skillsets"
import type { NotebookChangesPayload } from "@shared/task-groups"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotebookChangesRow, parseNotebookChangesPayload } from "./NotebookChangesRow"

const mocks = vi.hoisted(() => ({
	state: { clineMessages: [] as ClineMessage[] },
	apply: vi.fn(),
	discard: vi.fn(),
	action: vi.fn(),
	openSkills: vi.fn(),
}))
vi.mock("@/components/skills/skillsetStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/skills/skillsetStore")>()),
	openSkills: mocks.openSkills,
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		applyNotebookChanges: mocks.apply,
		discardNotebookChanges: mocks.discard,
		notebookAction: mocks.action,
	},
}))
const payload: NotebookChangesPayload = {
	revision: "r1",
	taskGroupId: "g1",
	threadId: "t1",
	status: "pending",
	changes: [
		{
			op: "update",
			slug: "plan",
			name: "Plan",
			description: "",
			content: "new",
			diff: [
				{ kind: "collapsed", text: "one\ntwo\nthree" },
				{ kind: "remove", text: "old" },
				{ kind: "add", text: "new" },
			],
		},
	],
}
const message = (ts = 10, p: unknown = payload): ClineMessage => ({
	ts,
	type: "say",
	say: "notebook_changes",
	text: JSON.stringify(p),
})
beforeEach(() => {
	mocks.apply.mockReset().mockResolvedValue({})
	mocks.discard.mockReset().mockResolvedValue({})
	mocks.action.mockReset().mockResolvedValue({})
	mocks.state = { clineMessages: [message()] }
})
const open = () => fireEvent.click(screen.getByRole("button", { name: /^Plan/ }))

describe("NotebookChangesRow", () => {
	it("shows one row with a chip per note, and opens a note only on click", () => {
		render(<NotebookChangesRow message={message()} />)
		expect(screen.getByTestId("notebook-changes-card")).toHaveTextContent("1 note change · this turn")
		expect(screen.getByRole("button", { name: /^Plan/ })).toHaveTextContent("+1 −1")
		expect(screen.queryByTestId("notebook-opened-change")).not.toBeInTheDocument()
		open()
		// The note renders as a page with the new line marked, not as a diff.
		expect(screen.getByTestId("marked-note")).toBeInTheDocument()
		expect(screen.queryByText("−old")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show as diff" }))
		expect(screen.getByText("−old")).toBeInTheDocument()
	})
	it("shows the agent's summary and how many turns the row carries", () => {
		const withSummary = { ...payload, turns: 2, changes: [{ ...payload.changes[0], summary: "Why the plan changed" }] }
		render(<NotebookChangesRow message={message(10, withSummary)} />)
		expect(screen.getByTestId("notebook-changes-card")).toHaveTextContent("last 2 turns")
		open()
		expect(screen.getByText("“Why the plan changed”")).toBeInTheDocument()
	})
	it("edits a staged note in place against the text it showed", async () => {
		render(<NotebookChangesRow message={message()} />)
		open()
		fireEvent.click(screen.getByRole("button", { name: "Edit Plan" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Plan body" }), { target: { value: "mine" } })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(
				expect.objectContaining({ action: "save_pending", slug: "plan", content: "mine", baseContent: "new" }),
			),
		)
	})
	it("shows a rejected-save draft with Retry / Reload / Discard draft", async () => {
		const withDraft = {
			...payload,
			changes: [{ ...payload.changes[0], draft: { ts: 5, reason: "the agent changed this note while you were editing" } }],
		}
		mocks.state = { clineMessages: [message(10, withDraft)] }
		render(<NotebookChangesRow message={message(10, withDraft)} />)
		open()
		expect(screen.getByTestId("notebook-draft-notice")).toHaveTextContent("Your text is kept as a draft")
		fireEvent.click(screen.getByRole("button", { name: /^Retry saving your edit/ }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "retry_draft", slug: "plan" })),
		)
		fireEvent.click(screen.getByRole("button", { name: /^Reload your draft/ }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "reload_draft", slug: "plan" })),
		)
		fireEvent.click(screen.getByRole("button", { name: /^Discard your draft/ }))
		await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "discard_draft" })))
	})
	it("keeps everything in one click and renders a summary", async () => {
		render(<NotebookChangesRow message={message()} />)
		fireEvent.click(screen.getByRole("button", { name: "Keep" }))
		await screen.findByText("Kept 1 note change")
		expect(mocks.apply).toHaveBeenCalledWith(
			expect.objectContaining({ taskGroupId: "g1", threadId: "t1", items: [{ slug: "plan", include: true }] }),
		)
	})
	it("keeps or drops one note from its opened view", async () => {
		const two = { ...payload, changes: [...payload.changes, { ...payload.changes[0], slug: "other", name: "Other" }] }
		mocks.state = { clineMessages: [message(10, two)] }
		render(<NotebookChangesRow message={message(10, two)} />)
		open()
		fireEvent.click(screen.getByRole("button", { name: "Keep Plan" }))
		await waitFor(() =>
			expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ items: [{ slug: "plan", include: true }] })),
		)
		// One of two kept: the row stays live until the host updates it.
		expect(screen.getByTestId("notebook-changes-card")).toBeInTheDocument()
		open()
		fireEvent.click(screen.getByRole("button", { name: "Drop Plan" }))
		await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith(expect.objectContaining({ slugs: ["plan"] })))
	})
	it("discards everything and renders a summary", async () => {
		render(<NotebookChangesRow message={message()} />)
		fireEvent.click(screen.getByRole("button", { name: "Discard" }))
		await screen.findByText("Dropped note changes")
		expect(mocks.discard).toHaveBeenCalledWith(
			expect.objectContaining({ taskGroupId: "g1", threadId: "t1", slugs: ["plan"] }),
		)
	})
	it("keeps failed actions reviewable", async () => {
		mocks.apply.mockRejectedValue(new Error("disk full"))
		render(<NotebookChangesRow message={message()} />)
		fireEvent.click(screen.getByRole("button", { name: "Keep" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("disk full")
		expect(screen.getByRole("button", { name: "Keep" })).toBeEnabled()
	})
	it("shows the user edit row and offers restore when replaced", async () => {
		render(
			<NotebookChangesRow
				message={message(10, { ...payload, changes: [{ ...payload.changes[0], replacedUserVersion: "user1" }] })}
			/>,
		)
		expect(screen.getByText(/You edited Plan/)).toBeInTheDocument()
		open()
		expect(screen.getByText("agent replaced your edit")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Restore" }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "restore_pending", slug: "plan" })),
		)
	})
	it("labels About you changes and opens About you from the summary", () => {
		const aboutYou = { ...payload, taskGroupId: "about-you", status: "applied" as const, kept: payload.changes }
		const navigate = vi.fn()
		mocks.state = { clineMessages: [message(10, aboutYou)], navigateToTaskGroup: navigate } as never
		render(<NotebookChangesRow message={message(10, aboutYou)} />)
		expect(screen.getByText("Kept 1 About you change")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Open About you" }))
		expect(navigate).toHaveBeenCalledWith("about-you", "notebook")
	})
	it.each([
		[["workflow"], "1 workflow", "Workflows"],
		[["skill", "workflow"], "1 skill and 1 workflow", "Skills"],
		[["skill", "workflow", "workflow"], "1 skill and 2 workflows", "Skills"],
	] as const)("counts final kinds %j in the saved Keep summary", (kinds, count, tab) => {
		const kept = kinds.map((kind, index) => ({
			op: "create" as const,
			slug: `skill-draft-${index}`,
			name: `draft-${index}`,
			description: "",
			skill: { kind, scope: "workspace" as const },
		}))
		const settled = message(10, { ...payload, taskGroupId: SKILL_DRAFTS_ID, status: "applied", changes: kept, kept })
		mocks.state.clineMessages = [settled]
		render(<NotebookChangesRow message={settled} />)
		expect(screen.getByText(`Kept ${count}`)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: `Open in ${tab}` }))
		expect(mocks.openSkills).toHaveBeenLastCalledWith({ tab: tab.toLowerCase() })
	})
	it("never offers actions on an older pending row, and keeps resolved summaries", () => {
		mocks.state = { clineMessages: [message(), message(20)] }
		const { rerender } = render(<NotebookChangesRow message={message()} />)
		expect(screen.getByTestId("notebook-changes-superseded")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Keep" })).not.toBeInTheDocument()
		rerender(<NotebookChangesRow message={message(10, { ...payload, status: "discarded" })} />)
		expect(screen.getByText("Dropped note changes")).toBeInTheDocument()
	})
	it("shows one row for a turn that changed notes, About you and a skill", async () => {
		const aboutYou = {
			...payload,
			taskGroupId: "about-you",
			revision: "r2",
			changes: [{ ...payload.changes[0], slug: "tools", name: "Tools", op: "create" as const }],
		}
		const skills = {
			...payload,
			taskGroupId: "skill-drafts",
			revision: "r3",
			changes: [
				{
					op: "create" as const,
					slug: "release-checklist",
					name: "release-checklist",
					description: "Cut a release",
					content: "1. Bump",
					summary: "Release steps from this thread",
					skill: {
						kind: "skill" as const,
						scope: "global" as const,
						files: [{ path: "scripts/verify.sh", content: "" }],
					},
				},
			],
		}
		const rows = [message(10), message(11, aboutYou), message(12, skills)]
		mocks.state = { clineMessages: rows, workspaceRoots: [{ path: "/w" }] } as never
		const { container } = render(
			<>
				{rows.map((row) => (
					<NotebookChangesRow key={row.ts} message={row} />
				))}
			</>,
		)
		expect(screen.getAllByTestId("notebook-changes-card")).toHaveLength(1)
		expect(screen.getByTestId("notebook-changes-card")).toHaveTextContent(
			"1 note change, 1 About you change, 1 skill · this turn",
		)
		expect(container.querySelectorAll("[data-testid=notebook-changes-card] button[aria-expanded]")).toHaveLength(3)
		expect(screen.getByRole("button", { name: /^release-checklist/ })).toHaveTextContent("new skill · 2 files")

		// The skill opens with Kind, Where, its files (the script flagged) and the body.
		fireEvent.click(screen.getByRole("button", { name: /^release-checklist/ }))
		expect(screen.getByTestId("skill-draft-opened")).toHaveTextContent("scripts/verify.sh")
		expect(screen.getByTestId("skill-draft-opened")).toHaveTextContent("Runs code")
		fireEvent.click(screen.getByRole("radio", { name: "Workflow" }))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(
				expect.objectContaining({ action: "skill_target", slug: "release-checklist", kind: "workflow", isGlobal: true }),
			),
		)

		fireEvent.click(screen.getByRole("button", { name: "Keep all" }))
		await screen.findByText("Kept 1 note change, 1 About you change, 1 skill")
		expect(mocks.apply.mock.calls.map(([request]) => request.taskGroupId)).toEqual(["g1", "about-you", "skill-drafts"])
		expect(screen.getByRole("button", { name: "Open in Skills" })).toBeInTheDocument()
	})
	it("rejects malformed payloads", () => {
		expect(parseNotebookChangesPayload("bad")).toBeNull()
		expect(parseNotebookChangesPayload(JSON.stringify({ threadId: "t1" }))).toBeNull()
	})
})

it("sends the visible item list and revision for Discard all", async () => {
	const p = { ...payload, changes: [...payload.changes, { ...payload.changes[0], slug: "second", name: "Second" }] }
	mocks.state.clineMessages = [message(10, p)]
	render(<NotebookChangesRow message={message(10, p)} />)
	fireEvent.click(screen.getByRole("button", { name: "Discard all" }))
	await waitFor(() =>
		expect(mocks.discard).toHaveBeenCalledWith(expect.objectContaining({ revision: "r1", slugs: ["plan", "second"] })),
	)
})

it("shows disk conflicts on the skill chip with version choices and both texts", async () => {
	const p: NotebookChangesPayload = {
		...payload,
		taskGroupId: "skill-drafts",
		changes: [
			{
				...payload.changes[0],
				slug: "skill-plan",
				skill: { kind: "skill", scope: "global", conflict: { "SKILL.md": btoa("disk text") } },
			},
		],
	}
	mocks.state.clineMessages = [message(10, p)]
	render(<NotebookChangesRow message={message(10, p)} />)
	expect(screen.getByRole("button", { name: /^Plan/ })).toHaveTextContent("changed on disk")
	open()
	fireEvent.click(screen.getByRole("button", { name: "Open both" }))
	expect(screen.getByText("disk text")).toBeInTheDocument()
	fireEvent.click(screen.getByRole("button", { name: "Keep theirs" }))
	await waitFor(() =>
		expect(mocks.action).toHaveBeenCalledWith(
			expect.objectContaining({ action: "skill_keep_theirs", slug: "skill-plan", revision: "r1" }),
		),
	)
})
