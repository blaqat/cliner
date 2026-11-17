import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "./ChatRow"

vi.mock("@/services/grpc-client", () => ({
	CheckpointsServiceClient: {},
	FileServiceClient: {},
	StateServiceClient: {},
	UiServiceClient: {},
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundEditEnabled: false,
		mcpServers: [],
		mcpDisplayMode: "plain",
		vscodeTerminalExecutionMode: "backgroundExec",
		clineMessages: [],
		showFeatureTips: false,
		enableCheckpointsSetting: false,
		mode: "act",
	}),
}))
// Highlighting is irrelevant here; expose the source so tests can see what was mounted.
vi.mock("../common/CodeBlock", () => ({
	default: ({ source }: { source: string }) => <pre data-testid="code">{source}</pre>,
	CODE_BLOCK_BG_COLOR: "transparent",
}))
vi.mock("@/components/common/CodeBlock", () => ({
	default: ({ source }: { source: string }) => <pre data-testid="code">{source}</pre>,
	CODE_BLOCK_BG_COLOR: "transparent",
}))
vi.mock("@/components/common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

const HUGE = "huge-output-line\n".repeat(130_000) // ~2.2 MB

function renderRow(message: ClineMessage, props: { isExpanded?: boolean; isLast?: boolean; onToggleExpand?: () => void } = {}) {
	const onToggleExpand = props.onToggleExpand ?? vi.fn()
	const view = render(
		<ChatRowContent
			isExpanded={props.isExpanded ?? false}
			isLast={props.isLast ?? false}
			message={message}
			onSetQuote={vi.fn()}
			onToggleExpand={onToggleExpand}
		/>,
	)
	return { ...view, onToggleExpand }
}

const tool = (type: "ask" | "say", fields: Record<string, unknown>): ClineMessage => ({
	ts: 1,
	type,
	[type]: "tool",
	text: JSON.stringify(fields),
})

describe("tool responses start collapsed", () => {
	it("keeps a command's output unmounted until opened, while the command stays visible", () => {
		const message: ClineMessage = {
			ts: 1,
			type: "say",
			say: "command",
			commandCompleted: true,
			text: `npm test\n${COMMAND_OUTPUT_STRING}\n${HUGE}`,
		}
		const { onToggleExpand } = renderRow(message)
		expect(screen.getByText(/npm test/)).toBeInTheDocument()
		expect(screen.queryByText(/huge-output-line/)).toBeNull()
		expect(screen.getAllByTestId("code")).toHaveLength(1)
		const toggle = screen.getByRole("button", { name: "Expand command output" })
		expect(toggle).toHaveTextContent("130000 lines")
		fireEvent.click(toggle)
		expect(onToggleExpand).toHaveBeenCalledTimes(1)
	})

	it("shows command output once the row is expanded", () => {
		const message: ClineMessage = {
			ts: 1,
			type: "say",
			say: "command",
			commandCompleted: true,
			text: `echo hi\n${COMMAND_OUTPUT_STRING}\nhello world`,
		}
		renderRow(message, { isExpanded: true })
		expect(screen.getByText(/hello world/)).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Collapse command output" })).toBeInTheDocument()
	})

	it("keeps a pending command visible for approval", () => {
		const message: ClineMessage = { ts: 1, type: "ask", ask: "command", text: "rm -rf build" }
		renderRow(message, { isLast: true })
		expect(screen.getByText(/rm -rf build/)).toBeInTheDocument()
	})

	it.each([
		["listFilesTopLevel"],
		["listFilesRecursive"],
		["listCodeDefinitionNames"],
	])("does not mount %s results until opened", (name) => {
		const { onToggleExpand } = renderRow(tool("say", { tool: name, path: "src", content: HUGE }))
		expect(screen.queryByText(/huge-output-line/)).toBeNull()
		expect(screen.queryByTestId("code")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Expand code block" }))
		expect(onToggleExpand).toHaveBeenCalled()
	})

	it("does not mount search results until opened", () => {
		renderRow(tool("say", { tool: "searchFiles", path: "src", regex: "foo", content: HUGE }))
		expect(screen.queryByText(/huge-output-line/)).toBeNull()
		expect(screen.getByRole("button", { name: "Expand code block" })).toBeInTheDocument()
	})

	it("does not mount multi-workspace search results until opened", () => {
		const content = `Found 2 results across 2 workspaces.\n## Workspace: a\n${HUGE}\n## Workspace: b\nmore`
		renderRow(tool("say", { tool: "searchFiles", path: "src", regex: "foo", content }))
		expect(screen.queryByText(/huge-output-line/)).toBeNull()
		expect(screen.getByLabelText("Expand search results")).toBeInTheDocument()
	})

	it("does not mount an MCP response until opened and opens on click", () => {
		const message: ClineMessage = { ts: 1, type: "say", say: "mcp_server_response", text: HUGE }
		const { onToggleExpand, rerender } = renderRow(message)
		expect(screen.queryByText(/huge-output-line/)).toBeNull()
		expect(screen.getByText("Response")).toBeInTheDocument()
		fireEvent.click(screen.getByText("Response"))
		expect(onToggleExpand).toHaveBeenCalledTimes(1)
		rerender(
			<ChatRowContent
				isExpanded={true}
				isLast={false}
				message={{ ...message, text: "small mcp result" }}
				onSetQuote={vi.fn()}
				onToggleExpand={onToggleExpand}
			/>,
		)
		expect(screen.getByText("small mcp result")).toBeInTheDocument()
	})
})

describe("rows that must stay visible", () => {
	it("renders the agent's text message in full", () => {
		renderRow({ ts: 1, type: "say", say: "text", text: "Here is what I found." })
		expect(screen.getByText("Here is what I found.")).toBeInTheDocument()
	})

	it("renders a follow-up question in full", () => {
		renderRow(
			{ ts: 1, type: "ask", ask: "followup", text: JSON.stringify({ question: "Which branch?", options: [] }) },
			{ isLast: true },
		)
		expect(screen.getByText("Which branch?")).toBeInTheDocument()
	})

	it("opens an edit waiting for approval so it can be reviewed", () => {
		const onToggleExpand = vi.fn()
		renderRow(tool("ask", { tool: "editedExistingFile", path: "a.ts", content: "const a = 1" }), {
			isLast: true,
			onToggleExpand,
		})
		expect(onToggleExpand).toHaveBeenCalledTimes(1)
	})

	it("does not auto-open an edit that is already resolved", () => {
		const onToggleExpand = vi.fn()
		renderRow(tool("say", { tool: "editedExistingFile", path: "a.ts", content: "const a = 1" }), { onToggleExpand })
		expect(onToggleExpand).not.toHaveBeenCalled()
		const approvedEarlier = renderRow(tool("ask", { tool: "editedExistingFile", path: "b.ts", content: "x" }), {
			isLast: false,
			onToggleExpand,
		})
		expect(onToggleExpand).not.toHaveBeenCalled()
		approvedEarlier.unmount()
	})

	it("shows an approval edit's content once expanded", () => {
		renderRow(tool("ask", { tool: "editedExistingFile", path: "a.ts", content: "const a = 1" }), {
			isExpanded: true,
			isLast: true,
		})
		expect(screen.getByTestId("code")).toHaveTextContent("const a = 1")
	})
})

describe("running commands", () => {
	afterEach(() => vi.useRealTimers())
	const running: ClineMessage = { ts: 1, type: "say", say: "command", text: `sleep 5\n${COMMAND_OUTPUT_STRING}\ntick` }

	it("opens live output after half a second and folds it away when the command finishes", () => {
		vi.useFakeTimers()
		const onToggleExpand = vi.fn()
		const { rerender } = renderRow(running, { onToggleExpand })
		expect(onToggleExpand).not.toHaveBeenCalled()
		act(() => {
			vi.advanceTimersByTime(600)
		})
		expect(onToggleExpand).toHaveBeenCalledTimes(1)

		// The list marks the row expanded, then the command completes.
		const row = (message: ClineMessage, isExpanded: boolean) => (
			<ChatRowContent
				isExpanded={isExpanded}
				isLast={false}
				message={message}
				onSetQuote={vi.fn()}
				onToggleExpand={onToggleExpand}
			/>
		)
		rerender(row(running, true))
		expect(screen.getByText(/tick/)).toBeInTheDocument()
		rerender(row({ ...running, commandCompleted: true }, true))
		expect(onToggleExpand).toHaveBeenCalledTimes(2)
	})

	it("does not reopen output the user folded while the command was still running", () => {
		vi.useFakeTimers()
		const onToggleExpand = vi.fn()
		const { rerender } = renderRow(running, { isExpanded: true, onToggleExpand })
		rerender(
			<ChatRowContent
				isExpanded={false}
				isLast={false}
				message={running}
				onSetQuote={vi.fn()}
				onToggleExpand={onToggleExpand}
			/>,
		)
		act(() => {
			vi.advanceTimersByTime(2000)
		})
		expect(onToggleExpand).not.toHaveBeenCalled()
	})
})
