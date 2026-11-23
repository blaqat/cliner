import type { AutomationDefinition } from "@shared/automations"
import { AutomationList } from "@shared/proto/cline/automation"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type AutomationEntry, resetAutomationsForTest } from "@/hooks/useAutomations"
import AutomationsPanel from "./AutomationsPanel"

const mocks = vi.hoisted(() => ({ list: vi.fn(), trust: vi.fn(), remove: vi.fn(), openFile: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
	AutomationServiceClient: {
		listAutomations: (request: unknown) => mocks.list(request),
		trustAutomation: (request: unknown) => mocks.trust(request),
		deleteAutomation: (request: unknown) => mocks.remove(request),
	},
	FileServiceClient: { openFile: (request: unknown) => mocks.openFile(request) },
}))

const definition: AutomationDefinition = {
	name: "review",
	title: "Review a ticket",
	description: "Two models review",
	arguments: [],
	steps: [
		{
			kind: "together",
			id: "r",
			title: "Review",
			prompt: "Review",
			threads: [
				{ id: "a", title: "A", prompt: "", model: "Opus", level: "", mode: "ask", worktree: false },
				{ id: "b", title: "B", prompt: "", model: "GPT", level: "", mode: "ask", worktree: false },
			],
		},
	],
}

const entry = (extra: Partial<AutomationEntry> = {}): AutomationEntry => ({
	name: "review",
	description: "Two models review",
	path: "/repo/.clinerules/automations/review.md",
	scope: "workspace",
	errors: [],
	trusted: true,
	fingerprint: "fp",
	definition,
	content: "",
	...extra,
})

describe("AutomationsPanel", () => {
	beforeEach(() => {
		const automations = [
			entry(),
			entry({
				name: "broken",
				path: "/home/.cline/automations/broken.md",
				scope: "global",
				definition: undefined,
				errors: ["Add a description"],
			}),
		]
		resetAutomationsForTest(automations)
		// The panel re-reads the folders; keep the same list.
		mocks.list.mockReset().mockImplementation(async () =>
			AutomationList.create({
				automations: automations.map((item) => ({
					...item,
					definitionJson: item.definition ? JSON.stringify(item.definition) : "",
				})),
				workspaceDir: "/repo/.clinerules/automations",
				globalDir: "/home/.cline/automations",
			}),
		)
		mocks.trust.mockReset()
		mocks.remove.mockReset()
		mocks.openFile.mockReset().mockResolvedValue({})
	})

	it("lists automations by scope with their steps; rows edit, Run starts, problems show", () => {
		const onRun = vi.fn()
		const onEdit = vi.fn()
		render(<AutomationsPanel onEdit={onEdit} onRun={onRun} />)
		const row = screen.getByTestId("automation-row-review")
		expect(row).toHaveTextContent("Review a ticket")
		expect(row).toHaveTextContent("/review")
		expect(screen.getByTestId("automation-summary-review")).toHaveTextContent("1 step · 2 threads · 2 models")
		fireEvent.click(within(row).getByRole("button", { name: /Review a ticket/ }))
		expect(onEdit).toHaveBeenCalledWith({ path: "/repo/.clinerules/automations/review.md" })
		fireEvent.click(screen.getByTestId("automation-run-review"))
		expect(onRun).toHaveBeenCalledWith("review")
		expect(screen.getByTestId("automation-errors-broken")).toHaveTextContent("Add a description")
		// A broken file opens in the editor instead of the builder.
		fireEvent.click(within(screen.getByTestId("automation-row-broken")).getByRole("button", { name: "broken" }))
		expect(mocks.openFile).toHaveBeenCalled()
		fireEvent.click(screen.getByTestId("automation-new"))
		expect(onEdit).toHaveBeenLastCalledWith({})
		fireEvent.click(screen.getByTestId("automation-describe"))
		expect(onEdit).toHaveBeenLastCalledWith({ describe: true })
	})

	it("hides Run for a changed file until it's trusted", async () => {
		resetAutomationsForTest([entry({ trusted: false })])
		mocks.list.mockResolvedValue(new Promise(() => {}))
		mocks.trust.mockResolvedValue(AutomationList.create({ automations: [] }))
		render(<AutomationsPanel onRun={vi.fn()} />)
		expect(screen.queryByTestId("automation-run-review")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Trust this version" }))
		await waitFor(() => expect(mocks.trust).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: "fp" })))
	})

	it("asks before deleting", async () => {
		mocks.list.mockResolvedValue(new Promise(() => {}))
		mocks.remove.mockResolvedValue(AutomationList.create({ automations: [] }))
		render(<AutomationsPanel />)
		fireEvent.click(screen.getByRole("button", { name: "Actions for review" }))
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))
		const confirm = screen.getByRole("alert")
		expect(confirm).toHaveTextContent("earlier runs stay")
		fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }))
		await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ value: entry().path })))
	})
})
