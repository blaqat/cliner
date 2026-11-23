import type { AutomationDefinition } from "@shared/automations"
import { AutomationList } from "@shared/proto/cline/automation"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetAutomationsForTest } from "@/hooks/useAutomations"
import { AutomationBuilder } from "./AutomationBuilder"

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	save: vi.fn(),
	preview: vi.fn(),
	draft: vi.fn(),
	propose: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ modelSettings: undefined, navigateToSettings: vi.fn() }),
}))
vi.mock("@/services/grpc-client", () => ({
	AutomationServiceClient: {
		listAutomations: (request: unknown) => mocks.list(request),
		saveAutomation: (request: unknown) => mocks.save(request),
		previewAutomationFile: (request: unknown) => mocks.preview(request),
		draftAutomation: (request: unknown) => mocks.draft(request),
		proposeAutomationEdit: (request: unknown) => mocks.propose(request),
	},
	FileServiceClient: { openFile: vi.fn(async () => ({})) },
}))

const saved: AutomationDefinition = {
	name: "review",
	title: "Review",
	description: "Two models review",
	arguments: [{ name: "ticket", kind: "ticket", required: true, description: "" }],
	steps: [
		{
			kind: "thread",
			id: "research",
			title: "Research",
			prompt: "Read {{ticket}}",
			model: "",
			level: "",
			mode: "ask",
			worktree: false,
		},
	],
}

const savedEntry = {
	name: "review",
	description: "Two models review",
	path: "/repo/.clinerules/automations/review.md",
	scope: "workspace" as const,
	errors: [],
	trusted: true,
	fingerprint: "fp",
	definition: saved,
	content: "",
}

describe("AutomationBuilder", () => {
	beforeEach(() => {
		resetAutomationsForTest([savedEntry])
		mocks.list
			.mockReset()
			.mockResolvedValue(
				AutomationList.create({ automations: [], workspaceDir: "/repo/.clinerules/automations", globalDir: "/home" }),
			)
		mocks.save.mockReset().mockResolvedValue(AutomationList.create({ savedPath: "/repo/.clinerules/automations/fix-it.md" }))
		mocks.preview.mockReset().mockResolvedValue({ value: "---\nname: fix-it\n---\n" })
		mocks.draft.mockReset()
		mocks.propose
			.mockReset()
			.mockResolvedValue({ fingerprint: "fp", proposedFile: "updated", diff: "+updated", errors: [], guesses: [] })
	})

	it("uses the revision the dirty editor opened with and can propose again from disk", async () => {
		mocks.save.mockRejectedValue(new Error("This automation changed in another window. Propose again from disk."))
		render(<AutomationBuilder target={{ path: savedEntry.path }} />)
		fireEvent.change(screen.getByTestId("builder-description"), { target: { value: "Window A draft" } })
		act(() => resetAutomationsForTest([{ ...savedEntry, fingerprint: "fp-b" }]))
		fireEvent.click(screen.getByRole("button", { name: "Change with a prompt…" }))
		fireEvent.change(screen.getByRole("textbox", { name: "What should change?" }), { target: { value: "Add a step" } })
		fireEvent.click(screen.getByRole("button", { name: "Propose changes" }))
		await waitFor(() => expect(mocks.propose).toHaveBeenCalledWith(expect.objectContaining({ editorBaseFingerprint: "fp" })))
		fireEvent.click(await screen.findByRole("button", { name: "Keep" }))
		expect(await screen.findByText(/changed in another window/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Propose from disk" }))
		await waitFor(() =>
			expect(mocks.propose).toHaveBeenLastCalledWith(expect.objectContaining({ editorDefinitionJson: undefined })),
		)
	})

	it("builds one from blank: problems show as you go, then Save writes it", async () => {
		render(<AutomationBuilder target={{}} />)
		expect(screen.getByTestId("builder-describe")).toBeInTheDocument()
		expect(screen.getByTestId("builder-save")).toBeDisabled()
		expect(screen.getByTestId("builder-general-issues")).toHaveTextContent("Add at least one step")

		fireEvent.change(screen.getByTestId("builder-name"), { target: { value: "Fix It" } })
		expect(screen.getByTestId("builder-name")).toHaveValue("fix-it")
		fireEvent.change(screen.getByTestId("builder-description"), { target: { value: "Fixes a ticket" } })
		fireEvent.click(screen.getByTestId("builder-add-thread"))
		expect(screen.getByTestId("builder-issues-thread")).toHaveTextContent("Write the prompt")
		fireEvent.change(screen.getByTestId("builder-prompt-thread"), { target: { value: "Fix {{nope}}" } })
		expect(screen.getByTestId("builder-issues-thread")).toHaveTextContent("{{nope}} isn't an argument")
		fireEvent.change(screen.getByTestId("builder-prompt-thread"), { target: { value: "Fix the bug" } })
		expect(screen.queryByTestId("builder-issues-thread")).not.toBeInTheDocument()

		fireEvent.click(screen.getByTestId("builder-save"))
		await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
		const request = mocks.save.mock.calls[0][0]
		expect(request.scope).toBe("workspace")
		expect(JSON.parse(request.definitionJson)).toMatchObject({
			name: "fix-it",
			description: "Fixes a ticket",
			steps: [{ kind: "thread", prompt: "Fix the bug", mode: "ask" }],
		})
		await waitFor(() => expect(screen.getByTestId("builder-status")).toHaveTextContent("Saved. Type /fix-it"))
	})

	it("edits a saved one, with placeholders to insert and the file it writes", async () => {
		render(<AutomationBuilder target={{ path: savedEntry.path }} />)
		expect(screen.getByTestId("builder-title")).toHaveTextContent("Review")
		expect(screen.queryByTestId("builder-describe")).not.toBeInTheDocument()
		const step = screen.getByTestId("builder-step-research")
		fireEvent.click(within(step).getByRole("button", { name: "{{ticket}}" }))
		expect(screen.getByTestId("builder-prompt-research")).toHaveValue("{{ticket}}Read {{ticket}}")
		fireEvent.click(screen.getByTestId("builder-save"))
		await waitFor(() => expect(mocks.save).toHaveBeenCalled())
		expect(mocks.save.mock.calls[0][0].previousPath).toBe(savedEntry.path)

		fireEvent.click(screen.getByTestId("builder-add-together"))
		const together = screen.getByTestId("builder-step-together")
		expect(within(together).getAllByRole("button", { name: "{{steps.research}}" })).toHaveLength(3)

		fireEvent.click(screen.getByRole("button", { name: "View the file it saves" }))
		await waitFor(() => expect(screen.getByTestId("builder-file")).toHaveTextContent("name: fix-it"))
		expect(screen.getByTestId("builder-file")).toHaveTextContent(".clinerules/automations/review.md")

		// The new group has no prompt yet, so Save waits and says why.
		expect(screen.getByTestId("builder-save")).toBeDisabled()
		expect(screen.getByTestId("builder-status")).toHaveTextContent("Fix 2 problems first")
	})

	it("adds a For each step: the steps after it sit in its bracket and get {{item}}", async () => {
		render(<AutomationBuilder target={{ path: savedEntry.path }} />)
		fireEvent.click(screen.getByTestId("builder-add-each"))
		expect(screen.getByTestId("builder-issues-each")).toHaveTextContent("Add the steps to run for each item after it")
		fireEvent.change(screen.getByTestId("builder-items-each"), { target: { value: "{{ticket}}" } })
		// Only one For each per automation.
		expect(screen.queryByTestId("builder-add-each")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("builder-add-thread"))
		const after = screen.getByTestId("builder-step-thread").closest("li") as HTMLElement
		expect(after).toHaveAttribute("data-per-item", "true")
		expect(after).toHaveTextContent("then, in each item's task")
		expect(within(after).getByRole("button", { name: "{{item}}" })).toBeInTheDocument()
		expect(within(after).getByRole("button", { name: "{{context}}" })).toBeInTheDocument()
		expect(screen.getByTestId("builder-step-research").closest("li")).not.toHaveAttribute("data-per-item")
		expect(screen.queryByTestId("builder-issues-each")).not.toBeInTheDocument()
	})

	it("drafts from a description and opens the draft with its guesses", async () => {
		mocks.draft.mockResolvedValue({
			definitionJson: JSON.stringify({ ...saved, name: "drafted" }),
			guesses: ["Which module /test should use"],
			model: "Sonnet 5.5",
		})
		render(<AutomationBuilder target={{ describe: true }} />)
		expect(screen.getByTestId("builder-draft")).toBeDisabled()
		fireEvent.change(screen.getByTestId("builder-describe-text"), { target: { value: "Research a ticket" } })
		await act(async () => {
			fireEvent.click(screen.getByTestId("builder-draft"))
		})
		expect(mocks.draft).toHaveBeenCalledWith(expect.objectContaining({ value: "Research a ticket" }))
		await waitFor(() => expect(screen.getByTestId("builder-name")).toHaveValue("drafted"))
		expect(screen.getByTestId("builder-guesses")).toHaveTextContent("Drafted with Sonnet 5.5")
		expect(screen.getByTestId("builder-guesses")).toHaveTextContent("Which module /test should use")
		expect(screen.queryByTestId("builder-describe")).not.toBeInTheDocument()
	})

	it("says why a draft failed", async () => {
		mocks.draft.mockRejectedValue(new Error("No model is set for generating text."))
		render(<AutomationBuilder target={{ describe: true }} />)
		fireEvent.change(screen.getByTestId("builder-describe-text"), { target: { value: "x" } })
		fireEvent.click(screen.getByTestId("builder-draft"))
		expect(await screen.findByText("No model is set for generating text.")).toBeInTheDocument()
	})
})
