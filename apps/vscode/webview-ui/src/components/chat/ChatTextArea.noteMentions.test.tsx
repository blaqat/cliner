import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setComposerPageTaskGroup } from "@/components/taskGroup/composerTaskGroup"
import ChatTextArea from "./ChatTextArea"
import { clearNoteMentionCache, findNoteMention, insertNoteMention, matchNotes } from "./noteMentions"

const mocks = vi.hoisted(() => ({
	getTaskGroup: vi.fn(),
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
		mcpServers: [],
		...mocks.state,
	}),
}))

vi.mock("@/context/PlatformContext", () => ({
	usePlatform: () => ({ togglePlanActKeys: "Meta+Shift+a" }),
}))

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
	},
	StateServiceClient: { togglePlanActModeProto: vi.fn(async () => ({})) },
	TaskGroupServiceClient: {
		getTaskGroup: (request: unknown) => mocks.getTaskGroup(request),
		setThreadTaskGroup: vi.fn(async () => ({})),
	},
}))

vi.mock("../cline-rules/ClineRulesToggleModal", () => ({ default: () => null }))
vi.mock("./ServersToggleModal", () => ({ default: () => null }))

const NOTES = [
	{ slug: "ticket-brief", name: "Ticket brief", description: "PROJ-482 scope and acceptance" },
	{ slug: "export-plan", name: "Export plan", description: "Steps for the bulk export" },
]

const onSend = vi.fn()

const Harness = () => {
	const [value, setValue] = useState("")
	return (
		<ChatTextArea
			inputValue={value}
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

async function type(textarea: HTMLElement, value: string) {
	await act(async () => {
		fireEvent.change(textarea, { target: { value } })
	})
}

async function renderInThread() {
	render(<Harness />)
	const textarea = screen.getByPlaceholderText("Type a message")
	fireEvent.focus(textarea)
	return textarea as HTMLTextAreaElement
}

describe("ChatTextArea #note mentions", () => {
	beforeEach(() => {
		clearNoteMentionCache()
		onSend.mockReset()
		mocks.getTaskGroup.mockReset().mockResolvedValue({ group: { id: "g1" }, notes: NOTES, threads: [] })
		mocks.state = {
			currentTaskItem: { id: "t1", taskGroupId: "g1", ts: 1, task: "Implement" },
			taskHistory: [],
			taskGroups: [{ id: "g1", title: "Bulk invoice export", tags: [], noteCount: 2 }],
		}
	})

	afterEach(() => {
		act(() => setComposerPageTaskGroup(undefined))
	})

	it("lists the task's notes on #, filters as you type, and Enter inserts the slug", async () => {
		const textarea = await renderInThread()
		await type(textarea, "see #")
		expect(mocks.getTaskGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }))
		expect(screen.getByTestId("note-mention-menu")).toHaveTextContent("Ticket brief")
		expect(screen.getByTestId("note-mention-menu")).toHaveTextContent("PROJ-482 scope and acceptance")

		await type(textarea, "see #exp")
		expect(screen.getByTestId("note-mention-menu")).not.toHaveTextContent("Ticket brief")

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea.value).toBe("see #export-plan ")
		expect(onSend).not.toHaveBeenCalled()
		expect(screen.queryByTestId("note-mention-menu")).not.toBeInTheDocument()
	})

	it("Tab and click pick a note; arrows move the selection", async () => {
		const textarea = await renderInThread()
		await type(textarea, "#")
		fireEvent.keyDown(textarea, { key: "ArrowDown" })
		fireEvent.keyDown(textarea, { key: "Tab" })
		expect(textarea.value).toBe("#export-plan ")

		await type(textarea, "#export-plan and #")
		fireEvent.click(screen.getByText("Ticket brief"))
		expect(textarea.value).toBe("#export-plan and #ticket-brief ")
	})

	it("closes on Esc without inserting, and fetches once per group", async () => {
		const textarea = await renderInThread()
		await type(textarea, "#t")
		fireEvent.keyDown(textarea, { key: "Escape" })
		expect(screen.queryByTestId("note-mention-menu")).not.toBeInTheDocument()
		expect(textarea.value).toBe("#t")

		await type(textarea, "#ti")
		await type(textarea, "")
		await type(textarea, "#")
		expect(screen.getByTestId("note-mention-menu")).toBeInTheDocument()
		expect(mocks.getTaskGroup).toHaveBeenCalledTimes(1)
	})

	it("ignores # inside a word", async () => {
		const textarea = await renderInThread()
		await type(textarea, "issue a#")
		expect(screen.queryByTestId("note-mention-menu")).not.toBeInTheDocument()
	})

	it("does nothing in a thread without a task", async () => {
		mocks.state.currentTaskItem = { id: "t2", ts: 1, task: "Loose" }
		const textarea = await renderInThread()
		await type(textarea, "#")
		expect(screen.queryByTestId("note-mention-menu")).not.toBeInTheDocument()
		expect(mocks.getTaskGroup).not.toHaveBeenCalled()
	})

	it("uses the task page's task when no thread is open", async () => {
		mocks.state.currentTaskItem = undefined
		act(() => setComposerPageTaskGroup("g1"))
		const textarea = await renderInThread()
		await type(textarea, "#")
		expect(screen.getByTestId("note-mention-menu")).toHaveTextContent("Export plan")
	})
})

describe("note mention helpers", () => {
	it("finds the #query before the cursor only at a word start", () => {
		expect(findNoteMention("see #tic", 8)).toEqual({ start: 4, query: "tic" })
		expect(findNoteMention("#", 1)).toEqual({ start: 0, query: "" })
		expect(findNoteMention("a#b", 3)).toBeUndefined()
		expect(findNoteMention("path/#b", 7)).toBeUndefined()
		expect(findNoteMention("#done here", 10)).toBeUndefined()
	})

	it("matches slug or name and replaces the query with the slug", () => {
		expect(matchNotes(NOTES, "brief").map((note) => note.slug)).toEqual(["ticket-brief"])
		expect(matchNotes(NOTES, "e").map((note) => note.slug)).toEqual(["export-plan", "ticket-brief"])
		expect(insertNoteMention("see #ti now", 7, 4, "ticket-brief")).toEqual({
			value: "see #ticket-brief now",
			cursor: 18,
		})
	})
})
