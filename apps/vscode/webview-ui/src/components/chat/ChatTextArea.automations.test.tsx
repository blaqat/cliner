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

function Harness({ initial = "", onSend }: { initial?: string; onSend: () => void }) {
	const [value, setValue] = useState(initial)
	return (
		<ChatTextArea
			inputValue={value}
			onOpenTaskGroup={mocks.onOpenTaskGroup}
			onScriptRun={mocks.onScriptRun}
			onSelectFilesAndImages={vi.fn()}
			onSend={onSend}
			placeholderText="Type a message"
			selectedFiles={[]}
			selectedImages={[]}
			sendingDisabled={false}
			setInputValue={setValue}
			setSelectedFiles={vi.fn()}
			setSelectedImages={vi.fn()}
			shouldDisableFilesAndImages={false}
		/>
	)
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function renderComposer(initial = "") {
	const onSend = vi.fn()
	render(<Harness initial={initial} onSend={onSend} />)
	const textarea = screen.getByPlaceholderText("Type a message") as HTMLTextAreaElement
	await waitFor(() => expect(mocks.listAutomations).toHaveBeenCalled())
	await reactAct(settle)
	return { onSend, textarea }
}

function type(textarea: HTMLTextAreaElement, value: string) {
	fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } })
}

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

	it("picking one from the menu opens the start form with its arguments and what will run", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "/review")
		await screen.findByTestId("slash-commands-menu")
		fireEvent.keyDown(textarea, { key: "Enter" })
		await waitFor(() => expect(textarea.value).toBe("/review-ticket "))
		const form = await screen.findByTestId("automation-start-form")
		expect(form).toHaveTextContent("Review a ticket")
		expect(screen.getByTestId("automation-arg-ticket")).toHaveTextContent("required")
		expect(screen.getByTestId("automation-arg-depth")).toHaveTextContent("default quick")
		const willRun = screen.getByTestId("automation-will-run")
		expect(willRun).toHaveTextContent("New task")
		expect(willRun).toHaveTextContent("Review {ticket}")
		expect(willRun).toHaveTextContent("Opus 5.5 · high· Ask")
		expect(willRun).toHaveTextContent("Your current model")
		expect(screen.getByTestId("automation-cost")).toHaveTextContent("Cost depends on")
		expect(screen.getByTestId("run-button")).toBeInTheDocument()
	})

	it("blocks Run until required arguments are set, then starts the run instead of sending", async () => {
		const { onSend, textarea } = await renderComposer("/review-ticket ")
		expect(await screen.findByTestId("automation-start-status")).toHaveTextContent("Needs ticket")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(mocks.startAutomationRun).not.toHaveBeenCalled()

		type(textarea, "/review-ticket ticket:PROJ-1 depth:deep")
		expect(screen.getByTestId("automation-start-status")).toHaveTextContent("Ready")
		fireEvent.keyDown(textarea, { key: "Enter" })
		await waitFor(() => expect(mocks.startAutomationRun).toHaveBeenCalledTimes(1))
		expect(mocks.startAutomationRun.mock.calls[0][0]).toMatchObject({
			name: "review-ticket",
			values: { ticket: "PROJ-1", depth: "deep" },
			fingerprint: "fp-review-ticket",
		})
		expect(onSend).not.toHaveBeenCalled()
		await waitFor(() => expect(textarea.value).toBe(""))
		expect(mocks.onOpenTaskGroup).toHaveBeenCalledWith("group-1")
	})

	it("offers the task's ticket and fills a clicked choice", async () => {
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
		const { textarea } = await renderComposer("/review-ticket ")
		await screen.findByTestId("automation-start-form")
		fireEvent.click(screen.getByTestId("automation-arg-ticket-PROJ-9"))
		expect(textarea.value).toBe("/review-ticket ticket:PROJ-9 ")
		fireEvent.click(screen.getByTestId("automation-arg-depth-deep"))
		expect(textarea.value).toBe("/review-ticket ticket:PROJ-9 depth:deep ")
		expect(screen.getByTestId("automation-start-form")).toHaveTextContent("Runs in this task: Retries")
	})

	it("Tab jumps to the next missing required argument", async () => {
		const { textarea } = await renderComposer("/review-ticket ")
		await screen.findByTestId("automation-start-form")
		fireEvent.keyDown(textarea, { key: "Tab" })
		expect(textarea.value).toBe("/review-ticket ticket:")
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
		expect(textarea.value).toBe("/review-ticket ticket:PROJ-1")
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
		await waitFor(() => expect(textarea.value).toBe("/review-ticket "))
		expect(screen.queryByTestId("top-bar-panel")).not.toBeInTheDocument()
		expect(await screen.findByTestId("automation-start-form")).toBeInTheDocument()
	})
})
