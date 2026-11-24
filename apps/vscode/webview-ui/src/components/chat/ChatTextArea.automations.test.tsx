import type { AutomationDefinition } from "@shared/automations"
import { AutomationInfo, AutomationList } from "@shared/proto/cline/automation"
import { fireEvent, act as reactAct, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetAutomationsForTest } from "@/hooks/useAutomations"
import { TopBarPanelOverlay } from "../topbar/TopBarPanelOverlay"
import { openTopBarPanel } from "../topbar/topBarPanels"
import ChatTextArea from "./ChatTextArea"

const mocks = vi.hoisted(() => ({
	listAutomations: vi.fn(),
	startAutomationRun: vi.fn(),
	trustAutomation: vi.fn(),
	onScriptRun: vi.fn(),
	onOpenTaskGroup: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mode: "act",
		apiConfiguration: {},
		openRouterModels: {},
		platform: "darwin",
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		remoteWorkflowToggles: {},
		remoteConfigSettings: undefined,
		navigateToSettingsModelPicker: vi.fn(),
		navigateToSettings: vi.fn(),
		mcpServers: [],
		taskHistory: [],
		...mocks.state,
	}),
}))
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ togglePlanActKeys: "Meta+Shift+a" }) }))
vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		selectedProvider: "anthropic",
		selectedModelId: "model",
		selectedModelInfo: { supportsImages: true },
	}),
}))
vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		searchCommits: vi.fn(async () => ({ commits: [] })),
		searchFiles: vi.fn(async () => ({ results: [] })),
		getRelativePaths: vi.fn(async () => ({ paths: [] })),
		openImage: vi.fn(async () => ({})),
		openFile: vi.fn(async () => ({})),
		refreshRules: vi.fn(async () => ({})),
		refreshHooks: vi.fn(async () => ({})),
		refreshSkills: vi.fn(async () => ({})),
	},
	AutomationServiceClient: {
		listAutomations: (request: unknown) => mocks.listAutomations(request),
		startAutomationRun: (request: unknown) => mocks.startAutomationRun(request),
		trustAutomation: (request: unknown) => mocks.trustAutomation(request),
		subscribeToAutomationRuns: vi.fn(() => () => {}),
	},
	StateServiceClient: { togglePlanActModeProto: vi.fn(async () => ({})) },
	McpServiceClient: { getLatestMcpServers: vi.fn(async () => ({ mcpServers: [] })) },
}))
vi.mock("@/hooks/useRemoteConfigSettings", () => ({ default: () => ({ settings: [], isLoading: false }) }))

const review: AutomationDefinition = {
	name: "review-ticket",
	title: "Review a ticket",
	description: "Two models review a ticket",
	arguments: [
		{ name: "ticket", kind: "ticket", required: true, description: "The ticket key" },
		{ name: "depth", kind: "choice", required: false, description: "How deep", choices: ["quick", "deep"], default: "quick" },
	],
	steps: [
		{
			kind: "together",
			id: "review",
			title: "Review {{ticket}}",
			prompt: "Review {{ticket}} ({{depth}}).",
			threads: [
				{ id: "a", title: "Opus", prompt: "", model: "Opus 5.5", level: "high", mode: "ask", worktree: false },
				{ id: "b", title: "GPT", prompt: "", model: "", level: "", mode: "ask", worktree: false },
			],
		},
	],
}

const info = (definition: AutomationDefinition, extra: Partial<AutomationInfo> = {}) =>
	AutomationInfo.create({
		name: definition.name,
		description: definition.description,
		path: `/repo/.clinerules/automations/${definition.name}.md`,
		scope: "workspace",
		trusted: true,
		fingerprint: `fp-${definition.name}`,
		definitionJson: JSON.stringify(definition),
		...extra,
	})

const listResponse = (extra: Partial<AutomationInfo> = {}) =>
	AutomationList.create({
		automations: [
			info(review, extra),
			AutomationInfo.create({ name: "broken", path: "/repo/.clinerules/automations/broken.md", errors: ["Bad"] }),
		],
		workspaceDir: "/repo/.clinerules/automations",
		globalDir: "/home/.cline/automations",
	})

function Harness({ initial = "", onSend, images = [] }: { initial?: string; onSend: () => void; images?: string[] }) {
	const [value, setValue] = useState(initial)
	const [selectedImages, setSelectedImages] = useState(images)
	return (
		<>
			<output data-testid="draft">{value}</output>
			<ChatTextArea
				inputValue={value}
				onOpenTaskGroup={mocks.onOpenTaskGroup}
				onScriptRun={mocks.onScriptRun}
				onSelectFilesAndImages={vi.fn()}
				onSend={onSend}
				placeholderText="Type a message"
				selectedFiles={[]}
				selectedImages={selectedImages}
				sendingDisabled={false}
				setInputValue={setValue}
				setSelectedFiles={vi.fn()}
				setSelectedImages={setSelectedImages}
				shouldDisableFilesAndImages={false}
			/>
		</>
	)
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function renderComposer(initial = "", images: string[] = []) {
	const onSend = vi.fn()
	render(<Harness images={images} initial={initial} onSend={onSend} />)
	const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement
	await waitFor(() => expect(mocks.listAutomations).toHaveBeenCalled())
	await reactAct(settle)
	return { onSend, textarea }
}

function type(textarea: HTMLTextAreaElement, value: string) {
	fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } })
}

const draft = () => screen.getByTestId("draft").textContent
const field = (name: string) => screen.getByTestId(`automation-field-${name}`) as HTMLInputElement

describe("ChatTextArea automations", () => {
	beforeEach(() => {
		resetAutomationsForTest()
		mocks.state = {}
		mocks.onScriptRun.mockReset()
		mocks.onOpenTaskGroup.mockReset()
		mocks.listAutomations.mockReset().mockResolvedValue(listResponse())
		mocks.startAutomationRun.mockReset().mockResolvedValue({ runId: "run-1", taskGroupId: "group-1" })
		mocks.trustAutomation.mockReset().mockResolvedValue(listResponse())
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("lists valid automations in the slash menu, only at the start of the message", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "/")
		const menu = await screen.findByTestId("slash-commands-menu")
		expect(menu).toHaveTextContent("Automations")
		expect(menu).toHaveTextContent("/review-ticket")
		expect(menu).toHaveTextContent("Two models review a ticket")
		expect(menu).not.toHaveTextContent("broken")
		type(textarea, "please /")
		expect(await screen.findByTestId("slash-commands-menu")).not.toHaveTextContent("review-ticket")
	})

	it("picking one from the menu turns it into chips: the command, then a field per argument", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "/review")
		await screen.findByTestId("slash-commands-menu")
		fireEvent.keyDown(textarea, { key: "Enter" })
		await waitFor(() => expect(draft()).toBe("/review-ticket "))
		expect(screen.getByTestId("automation-command-chip")).toHaveTextContent("/review-ticket")
		expect(field("ticket")).toHaveAccessibleName("ticket, required: The ticket key")
		expect(field("depth")).toHaveAttribute("placeholder", "quick")
		// The caret goes to the first argument to fill; the text box below is for context.
		await waitFor(() => expect(field("ticket")).toHaveFocus())
		expect(textarea.value).toBe("")
		expect(textarea).toHaveAttribute("placeholder", "Add context for this run (optional): notes, @files, images")
		expect(screen.getByTestId("automation-arg-help")).toHaveTextContent("ticket · required · The ticket key")
		const form = await screen.findByTestId("automation-start-form")
		expect(form).toHaveTextContent("Review a ticket")
		const willRun = screen.getByTestId("automation-will-run")
		expect(willRun).toHaveTextContent("New task")
		// What isn't filled yet shows as the placeholder the steps write, set off as code.
		expect(willRun).toHaveTextContent("Review {{ticket}}")
		expect(within(willRun).getByText("{{ticket}}").tagName).toBe("CODE")
		expect(willRun).toHaveTextContent("Opus 5.5 · high· Ask")
		expect(willRun).toHaveTextContent("Your current model")
		expect(screen.getByTestId("automation-uses-1")).toHaveTextContent("uses ticket")
		expect(screen.getByTestId("automation-cost")).toHaveTextContent("Cost depends on")
		expect(screen.getByTestId("run-button")).toBeInTheDocument()
	})

	it("lists a long automation's first steps and folds the rest, so the form has no scrollbar of its own", async () => {
		const long: AutomationDefinition = {
			...review,
			name: "long-run",
			arguments: [],
			steps: Array.from({ length: 7 }, (_, index) => ({
				kind: "thread" as const,
				id: `s${index + 1}`,
				title: `Step ${index + 1}`,
				prompt: "Go",
				model: "",
				level: "",
				mode: "ask" as const,
				worktree: false,
			})),
		}
		mocks.listAutomations.mockResolvedValue(
			AutomationList.create({ automations: [info(long)], workspaceDir: "/repo/.clinerules/automations", globalDir: "" }),
		)
		const { textarea } = await renderComposer()
		type(textarea, "/long-run ")
		const form = await screen.findByTestId("automation-start-form")
		expect(form.className).not.toMatch(/overflow-y-auto|max-h-/)
		const willRun = screen.getByTestId("automation-will-run")
		// "New task", then steps 1–3; the other four fold.
		expect(willRun).toHaveTextContent("Step 3")
		expect(willRun).not.toHaveTextContent("Step 4")
		fireEvent.click(screen.getByTestId("automation-all-steps"))
		expect(willRun).toHaveTextContent("Step 7")
		expect(screen.getByTestId("automation-all-steps")).toHaveTextContent("Show fewer steps")
	})

	it("fills the chips from text typed or pasted fast, the rest is context", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "/review-ticket PROJ-7 deep and check the login page\nToo")
		await waitFor(() => expect(field("ticket").value).toBe("PROJ-7"))
		expect(field("depth").value).toBe("deep")
		expect(textarea.value).toBe("and check the login page\nToo")
	})

	it("reads the older name:value form too", async () => {
		await renderComposer('/review-ticket depth:deep ticket:"PROJ 8"')
		await waitFor(() => expect(field("ticket").value).toBe("PROJ 8"))
		expect(field("depth").value).toBe("deep")
	})

	it("blocks Run until required arguments are set, then starts the run with its context", async () => {
		const { onSend, textarea } = await renderComposer("/review-ticket ", ["data:image/png;base64,AAA"])
		expect(await screen.findByTestId("automation-start-status")).toHaveTextContent("Needs ticket")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(mocks.startAutomationRun).not.toHaveBeenCalled()
		expect(field("ticket")).toHaveFocus()
		expect(screen.getByTestId("automation-chip-ticket").className).toContain("border-error")

		fireEvent.change(field("ticket"), { target: { value: "PROJ-1" } })
		fireEvent.keyDown(field("ticket"), { key: "Tab" })
		expect(field("depth")).toHaveFocus()
		fireEvent.keyDown(field("depth"), { key: "ArrowDown" })
		expect(field("depth").value).toBe("deep")
		fireEvent.keyDown(field("depth"), { key: "Tab" })
		expect(textarea).toHaveFocus()
		type(textarea, "Only the API")
		expect(draft()).toBe("/review-ticket ticket:PROJ-1 depth:deep\nOnly the API")
		expect(screen.getByTestId("automation-start-status")).toHaveTextContent("Ready")
		expect(screen.getByTestId("automation-context")).toHaveTextContent(
			"Your context (1 line, 1 image) goes with every thread",
		)
		fireEvent.keyDown(textarea, { key: "Enter" })
		await waitFor(() => expect(mocks.startAutomationRun).toHaveBeenCalledTimes(1))
		expect(mocks.startAutomationRun.mock.calls[0][0]).toMatchObject({
			name: "review-ticket",
			values: { ticket: "PROJ-1", depth: "deep" },
			fingerprint: "fp-review-ticket",
			context: "Only the API",
			contextImages: ["data:image/png;base64,AAA"],
		})
		expect(onSend).not.toHaveBeenCalled()
		await waitFor(() => expect(draft()).toBe(""))
		expect(mocks.onOpenTaskGroup).toHaveBeenCalledWith("group-1")
	})

	it("Enter in the last field runs it", async () => {
		await renderComposer("/review-ticket ticket:PROJ-1")
		fireEvent.keyDown(field("depth"), { key: "Enter" })
		await waitFor(() => expect(mocks.startAutomationRun).toHaveBeenCalledTimes(1))
		expect(mocks.startAutomationRun.mock.calls[0][0].values).toEqual({ ticket: "PROJ-1" })
	})

	it("offers the task's ticket and the choices under the field being edited", async () => {
		mocks.state = {
			currentTaskItem: {
				id: "t1",
				task: "x",
				ts: 1,
				taskGroupId: "g1",
				tags: [{ kind: "ticket", value: "PROJ-9", source: "auto" }],
			},
			taskHistory: [{ id: "t1", task: "x", ts: 1, taskGroupId: "g1" }],
			taskGroups: [{ id: "g1", title: "Retries", tags: [], createdAt: 1, updatedAt: 1, noteCount: 0 }],
		}
		await renderComposer("/review-ticket ")
		await waitFor(() => expect(field("ticket")).toHaveFocus())
		fireEvent.click(screen.getByTestId("automation-option-ticket-PROJ-9"))
		expect(draft()).toBe("/review-ticket ticket:PROJ-9")
		expect(field("depth")).toHaveFocus()
		fireEvent.click(screen.getByTestId("automation-option-depth-deep"))
		expect(draft()).toBe("/review-ticket ticket:PROJ-9 depth:deep")
		expect(screen.getByTestId("automation-start-form")).toHaveTextContent("Runs in this task: Retries")
	})

	it("Space ends a one-word value, and Backspace steps back to the command and removes it", async () => {
		const { textarea } = await renderComposer("/review-ticket ")
		await waitFor(() => expect(field("ticket")).toHaveFocus())
		fireEvent.change(field("ticket"), { target: { value: "PROJ-2" } })
		fireEvent.keyDown(field("ticket"), { key: " " })
		expect(field("depth")).toHaveFocus()
		// A partly typed choice becomes the choice it starts.
		fireEvent.change(field("depth"), { target: { value: "de" } })
		fireEvent.keyDown(field("depth"), { key: "Tab" })
		expect(draft()).toBe("/review-ticket ticket:PROJ-2 depth:deep")
		// Backspace at the start of the context goes back to the last field.
		fireEvent.keyDown(textarea, { key: "Backspace" })
		expect(field("depth")).toHaveFocus()
		field("ticket").focus()
		field("ticket").setSelectionRange(0, 0)
		fireEvent.keyDown(field("ticket"), { key: "Backspace" })
		expect(screen.getByTestId("automation-command-chip")).toHaveFocus()
		fireEvent.keyDown(screen.getByTestId("automation-command-chip"), { key: "Backspace" })
		await waitFor(() => expect(draft()).toBe("/review-ticket"))
		expect(screen.queryByTestId("automation-args-row")).not.toBeInTheDocument()
		expect(textarea.value).toBe("/review-ticket")
	})

	it.each([
		[0.001, "$0.001"],
		[12.5, "$12.50"],
	])("shows the %s cost limit in the automation start form", async (costLimit, label) => {
		mocks.listAutomations.mockResolvedValue(AutomationList.create({ automations: [info({ ...review, costLimit })] }))
		await renderComposer("/review-ticket ticket:PROJ-1")
		expect(await screen.findByTestId("automation-cost")).toHaveTextContent(`Stops itself at ${label}.`)
	})

	it("won't run a version that changed since it was trusted, and trusts it on request", async () => {
		mocks.listAutomations.mockResolvedValue(listResponse({ trusted: false }))
		const { textarea } = await renderComposer("/review-ticket ticket:PROJ-1")
		expect(await screen.findByTestId("automation-untrusted")).toBeInTheDocument()
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(mocks.startAutomationRun).not.toHaveBeenCalled()
		fireEvent.click(within(screen.getByTestId("automation-untrusted")).getByRole("button", { name: "Trust this version" }))
		await waitFor(() => expect(mocks.trustAutomation).toHaveBeenCalledTimes(1))
		await waitFor(() => expect(screen.queryByTestId("automation-untrusted")).not.toBeInTheDocument())
	})

	it("shows why a run didn't start", async () => {
		mocks.startAutomationRun.mockRejectedValue(new Error("Opus 5.5 isn't set up."))
		const { textarea } = await renderComposer("/review-ticket ticket:PROJ-1")
		await screen.findByTestId("automation-start-form")
		fireEvent.keyDown(textarea, { key: "Enter" })
		await waitFor(() => expect(screen.getByTestId("automation-start-status")).toHaveTextContent("Opus 5.5 isn't set up."))
		expect(draft()).toBe("/review-ticket ticket:PROJ-1")
	})

	it("leaves ordinary messages alone", async () => {
		const { onSend, textarea } = await renderComposer()
		type(textarea, "just a message")
		expect(screen.queryByTestId("automation-start-form")).not.toBeInTheDocument()
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	it("Run in the Rules & workflows overlay starts the draft and closes the overlay", async () => {
		render(<TopBarPanelOverlay />)
		const { textarea } = await renderComposer()
		reactAct(() => openTopBarPanel("rules"))
		fireEvent.click(within(screen.getByTestId("rules-panel")).getByRole("button", { name: "Automations" }))
		fireEvent.click(await screen.findByTestId("automation-run-review-ticket"))
		await waitFor(() => expect(draft()).toBe("/review-ticket "))
		expect(textarea.value).toBe("")
		await waitFor(() => expect(field("ticket")).toHaveFocus())
		expect(screen.queryByTestId("top-bar-panel")).not.toBeInTheDocument()
		expect(await screen.findByTestId("automation-start-form")).toBeInTheDocument()
	})
})
