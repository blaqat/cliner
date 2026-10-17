import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setComposerPageTaskGroup, setComposerTaskGroup } from "@/components/taskGroup/composerTaskGroup"
import ChatTextArea from "./ChatTextArea"
import { clearNoteMentionCache, findNoteMention, insertNoteMention, matchNotes } from "./noteMentions"
import { findThreadMention, insertThreadMention, matchThreads } from "./threadMentions"

const mocks = vi.hoisted(() => ({
	listAllNotes: vi.fn(),
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
	TaskServiceClient: {
		getTaskHistory: vi.fn(async () => ({ tasks: [], hasMore: false })),
		resolveMessageLink: vi.fn(async () => ({ text: "" })),
	},
	TaskGroupServiceClient: {
		listAllNotes: (request: unknown) => mocks.listAllNotes(request),
		setThreadTaskGroup: vi.fn(async () => ({})),
	},
}))

vi.mock("../cline-rules/ClineRulesToggleModal", () => ({ default: () => null }))
vi.mock("./ServersToggleModal", () => ({ default: () => null }))

const OWN_NOTES = [
	{ slug: "ticket-brief", name: "Ticket brief", description: "PROJ-482 scope and acceptance" },
	{ slug: "export-plan", name: "Export plan", description: "Steps for the bulk export" },
]
const OTHER_NOTES = [
	{ slug: "timezone-handling", name: "Timezone handling", description: "UTC everywhere" },
	{ slug: "export-plan", name: "Export plan (old)", description: "Previous task's version" },
]

const ALL_NOTES_RESPONSE = {
	groups: [
		{ taskGroupId: "g2", taskGroupTitle: "SSO redirect loop", notes: OTHER_NOTES },
		{ taskGroupId: "g1", taskGroupTitle: "Bulk invoice export", notes: OWN_NOTES },
	],
}

const onSend = vi.fn()
const onPasteMessageLink = vi.fn()

const Harness = () => {
	const [value, setValue] = useState("")
	return (
		<ChatTextArea
			inputValue={value}
			onPasteMessageLink={onPasteMessageLink}
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
		mocks.listAllNotes.mockReset().mockResolvedValue(ALL_NOTES_RESPONSE)
		mocks.state = {
			currentTaskItem: { id: "t1", taskGroupId: "g1", ts: 1, task: "Implement" },
			taskHistory: [],
			taskGroups: [
				{ id: "g1", title: "Bulk invoice export", tags: [], noteCount: 2 },
				{ id: "g2", title: "SSO redirect loop", tags: [], noteCount: 2 },
			],
		}
	})

	afterEach(() => {
		act(() => {
			setComposerPageTaskGroup(undefined)
			setComposerTaskGroup(undefined)
		})
	})

	it("lists the task's notes first, then other tasks' notes with their task name", async () => {
		const textarea = await renderInThread()
		await type(textarea, "see #")
		expect(mocks.listAllNotes).toHaveBeenCalled()
		const menu = screen.getByTestId("note-mention-menu")
		expect(menu).toHaveTextContent("Ticket brief")
		expect(menu).toHaveTextContent("This task · Bulk invoice export")
		expect(menu).toHaveTextContent("Other tasks")
		expect(menu).toHaveTextContent("Timezone handling")
		expect(menu).toHaveTextContent("SSO redirect loop")

		// Own task's notes rank above other tasks' notes
		const options = menu.querySelectorAll('[role="option"]')
		expect(options[0]).toHaveTextContent("Ticket brief")
		expect(options[1]).toHaveTextContent("Export plan")
	})

	it("filters as you type and Enter inserts the slug for a current-task note", async () => {
		const textarea = await renderInThread()
		await type(textarea, "see #tick")
		const menu = screen.getByTestId("note-mention-menu")
		expect(menu).not.toHaveTextContent("Export plan")

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea.value).toBe("see #ticket-brief ")
		expect(onSend).not.toHaveBeenCalled()
		expect(screen.queryByTestId("note-mention-menu")).not.toBeInTheDocument()
	})

	it("inserts #task-slug/note-slug for a note from another task", async () => {
		const textarea = await renderInThread()
		await type(textarea, "check #timezone")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea.value).toBe("check #sso-redirect-loop/timezone-handling ")
	})

	it("Tab and click pick a note; arrows move the selection", async () => {
		const textarea = await renderInThread()
		await type(textarea, "#ti")
		fireEvent.keyDown(textarea, { key: "Tab" })
		expect(textarea.value).toBe("#ticket-brief ")

		await type(textarea, "#ticket-brief and #exp")
		fireEvent.click(screen.getByText("Export plan"))
		expect(textarea.value).toBe("#ticket-brief and #export-plan ")
	})

	it("closes on Esc without inserting, and fetches once per snapshot", async () => {
		const textarea = await renderInThread()
		await type(textarea, "#t")
		fireEvent.keyDown(textarea, { key: "Escape" })
		expect(screen.queryByTestId("note-mention-menu")).not.toBeInTheDocument()
		expect(textarea.value).toBe("#t")

		await type(textarea, "#ti")
		await type(textarea, "")
		await type(textarea, "#")
		expect(screen.getByTestId("note-mention-menu")).toBeInTheDocument()
		expect(mocks.listAllNotes).toHaveBeenCalledTimes(1)
	})

	it("ignores # inside a word", async () => {
		const textarea = await renderInThread()
		await type(textarea, "issue a#")
		expect(screen.queryByTestId("note-mention-menu")).not.toBeInTheDocument()
	})

	it("shows every task's notes even when the open thread is in no task", async () => {
		mocks.state.currentTaskItem = { id: "t2", ts: 1, task: "Loose" }
		const textarea = await renderInThread()
		await type(textarea, "#")
		const menu = screen.getByTestId("note-mention-menu")
		// No "This task" section when the thread is unfiled — everything is another task's.
		expect(menu).not.toHaveTextContent("This task")
		expect(menu).toHaveTextContent("Ticket brief")
		expect(menu).toHaveTextContent("Timezone handling")
		// Insert still uses the qualified form.
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea.value).toBe("#sso-redirect-loop/timezone-handling ")
	})

	it("uses the task page's task when no thread is open", async () => {
		mocks.state.currentTaskItem = undefined
		act(() => setComposerPageTaskGroup("g1"))
		const textarea = await renderInThread()
		await type(textarea, "#")
		expect(screen.getByTestId("note-mention-menu")).toHaveTextContent("Export plan")
		// First own-task note, inserted as a bare slug
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea.value).toBe("#ticket-brief ")
	})

	it("uses the home composer's pending task pill pick", async () => {
		mocks.state.currentTaskItem = undefined
		const textarea = await renderInThread()
		act(() => setComposerTaskGroup("g1"))
		await type(textarea, "#")
		expect(screen.getByTestId("note-mention-menu")).toHaveTextContent("Export plan")
		expect(mocks.listAllNotes).toHaveBeenCalled()
	})

	it("does not select a note on Enter/Tab/arrows while IME composing", async () => {
		const textarea = await renderInThread()
		await type(textarea, "#")
		fireEvent.keyDown(textarea, { key: "Enter", isComposing: true, keyCode: 229 })
		fireEvent.keyDown(textarea, { key: "Tab", isComposing: true, keyCode: 229 })
		fireEvent.keyDown(textarea, { key: "ArrowDown", isComposing: true, keyCode: 229 })
		fireEvent.keyDown(textarea, { key: "Escape", isComposing: true, keyCode: 229 })
		expect(textarea.value).toBe("#")
		expect(screen.getByTestId("note-mention-menu")).toBeInTheDocument()

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea.value).toBe("#ticket-brief ")
	})
})

describe("ChatTextArea thread: mentions and message-link paste", () => {
	beforeEach(() => {
		onSend.mockReset()
		onPasteMessageLink.mockReset()
		mocks.state = {
			currentTaskItem: { id: "t1", taskGroupId: "g1", ts: 1, task: "Implement" },
			taskHistory: [
				{ id: "t1", ts: 1, task: "Implement", taskGroupId: "g1" },
				{ id: "t2", ts: 2, task: "first message", title: "Repro on staging", taskGroupId: "g2" },
				{ id: "t3", ts: 3, task: "Loose thread" },
			],
			taskGroups: [
				{ id: "g1", title: "Bulk invoice export", tags: [], noteCount: 0 },
				{ id: "g2", title: "SSO redirect loop", tags: [], noteCount: 0 },
			],
		}
	})

	it("lists threads from any task by title, with the task name, and inserts thread:<id>", async () => {
		const textarea = await renderInThread()
		await type(textarea, "what about thread:repro")
		const menu = screen.getByTestId("thread-mention-menu")
		expect(menu).toHaveTextContent("Repro on staging")
		expect(menu).toHaveTextContent("SSO redirect loop")
		// The open thread is never offered to itself.
		expect(menu).not.toHaveTextContent("Implement")

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea.value).toBe("what about thread:t2 ")
		expect(onSend).not.toHaveBeenCalled()
	})

	it("turns a pasted message link into onPasteMessageLink instead of text", async () => {
		const textarea = await renderInThread()
		const url = "vscode://saoudrizwan.cliner/thread/t2?m=7"
		const notCanceled = fireEvent.paste(textarea, { clipboardData: { items: [], getData: () => url } })
		expect(notCanceled).toBe(false)
		expect(onPasteMessageLink).toHaveBeenCalledWith({ threadId: "t2", messageIndex: 7 }, url)
		expect(textarea.value).toBe("")
	})

	it("leaves other pasted URLs as text", async () => {
		const textarea = await renderInThread()
		fireEvent.paste(textarea, { clipboardData: { items: [], getData: () => "https://example.com/x" } })
		expect(onPasteMessageLink).not.toHaveBeenCalled()
	})
})

describe("thread mention helpers", () => {
	it("finds thread:query only at a word start", () => {
		expect(findThreadMention("see thread:rep", 14)).toEqual({ start: 4, query: "rep" })
		expect(findThreadMention("thread:", 7)).toEqual({ start: 0, query: "" })
		expect(findThreadMention("a/thread:x", 10)).toBeUndefined()
		expect(findThreadMention("vscode://x/thread/t1", 20)).toBeUndefined()
	})

	it("inserts the id and ranks title prefix matches first, skipping the open thread", () => {
		expect(insertThreadMention("see thread:re now", 13, 4, "t2")).toEqual({ value: "see thread:t2 now", cursor: 14 })
		const threads = [
			{ id: "a", title: "Old repro", ts: 5 },
			{ id: "b", title: "Repro on staging", ts: 1 },
			{ id: "c", title: "Repro current", ts: 9, isCurrentThread: true },
			{ id: "d", title: "Unrelated", taskGroupTitle: "Repro task", ts: 9 },
		]
		expect(matchThreads(threads, "repro").map((t) => t.id)).toEqual(["b", "a", "d"])
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

	it("matches slug or name, current-task notes first", () => {
		const notes = [
			{
				slug: "timezone-handling",
				name: "Timezone handling",
				isCurrentTask: false,
				insertText: "#sso-redirect-loop/timezone-handling",
			},
			{ slug: "ticket-brief", name: "Ticket brief", isCurrentTask: true, insertText: "#ticket-brief" },
			{ slug: "export-plan", name: "Export plan", isCurrentTask: true, insertText: "#export-plan" },
		]
		expect(matchNotes(notes, "e").map((note) => note.slug)).toEqual(["export-plan", "ticket-brief", "timezone-handling"])
		expect(matchNotes(notes, "").map((note) => note.slug)).toEqual(["ticket-brief", "export-plan", "timezone-handling"])
	})

	it("replaces the query with a qualified or bare mention", () => {
		expect(insertNoteMention("see #ti now", 7, 4, "#ticket-brief")).toEqual({
			value: "see #ticket-brief now",
			cursor: 18,
		})
		expect(insertNoteMention("see #ti now", 7, 4, "#sso-redirect-loop/ticket-brief")).toEqual({
			value: "see #sso-redirect-loop/ticket-brief now",
			cursor: 36,
		})
	})
})
