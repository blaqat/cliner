import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { parseScriptOutcome, parseScriptTool, ScriptToolRow } from "./ScriptToolRow"

const mocks = vi.hoisted(() => ({ openFile: vi.fn(async () => ({})), askResponse: vi.fn(async () => ({})) }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ currentTaskItem: { id: "thread" }, turnState: { anchorTs: 1 }, pendingSubagentDecisions: [] }),
}))
vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { openFile: (request: unknown) => mocks.openFile(request) },
	TaskServiceClient: { askResponse: (request: unknown) => mocks.askResponse(request) },
}))

describe("parseScriptTool", () => {
	it("ignores other tools", () => {
		expect(parseScriptTool({ tool: "readFile" })).toBeNull()
		expect(parseScriptTool(null)).toBeNull()
	})

	it("reads the action, name and option values", () => {
		expect(
			parseScriptTool({
				tool: "script",
				scriptAction: "run",
				name: "deploy",
				scriptOptions: { env: "prod", dry: true, bad: 3 },
			}),
		).toEqual({
			action: "run",
			name: "deploy",
			options: [
				["env", "prod"],
				["dry", true],
			],
			outcome: undefined,
			command: undefined,
			cwd: undefined,
		})
		expect(parseScriptTool({ tool: "script", scriptAction: "load", name: "deploy" })?.action).toBe("load")
	})
})

describe("ScriptToolRow", () => {
	it("asks about the script by name and values", () => {
		render(
			<ScriptToolRow
				asking
				info={{
					action: "run",
					name: "deploy",
					options: [
						["env", "prod"],
						["dry", true],
					],
				}}
			/>,
		)
		const row = screen.getByTestId("script-tool-row")
		expect(row).toHaveTextContent("Cline wants to run the script:")
		expect(row).toHaveTextContent("deploy")
		expect(row).toHaveTextContent("envprod")
		expect(row).toHaveTextContent("dry")
	})

	it("reports a finished run and a loaded script in the past tense", () => {
		const { rerender } = render(<ScriptToolRow asking={false} info={{ action: "run", name: "deploy", options: [] }} />)
		expect(screen.getByTestId("script-tool-row")).toHaveTextContent("Cline ran the script:")
		rerender(<ScriptToolRow asking={false} info={{ action: "load", name: "deploy", options: [] }} />)
		expect(screen.getByTestId("script-tool-row")).toHaveTextContent("Cline read the script notes:")
	})
})

const RAN =
	'Script "deploy" failed (exit code 3).\nOutput (last 100 of 250 lines):\nline a\nline b\nFull log: /logs/deploy.log (read it for earlier output)'

describe("parseScriptOutcome", () => {
	it("reads the status, output tail and log path", () => {
		expect(parseScriptOutcome(RAN)).toEqual({
			ok: false,
			status: "failed (exit code 3)",
			output: "line a\nline b",
			logPath: "/logs/deploy.log",
		})
		expect(parseScriptOutcome('Script "x" succeeded (exit code 0).\nNo output.\nFull log: /l.log')).toMatchObject({
			ok: true,
			output: "",
			logPath: "/l.log",
		})
	})

	it("shows tool errors as a failed run", () => {
		expect(parseScriptOutcome('Error: Option "env" is required.')).toEqual({
			ok: false,
			status: 'Option "env" is required.',
			output: "",
		})
	})
})

describe("ScriptToolRow outcome", () => {
	const info = { action: "run" as const, name: "deploy", options: [], outcome: RAN }

	it("shows the exit status, with the output and log one click away", () => {
		render(<ScriptToolRow asking={false} info={info} />)
		expect(screen.getByTestId("script-outcome")).toHaveTextContent("failed (exit code 3)")
		expect(screen.queryByText("line a", { exact: false })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show output" }))
		expect(screen.getByText(/line a/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Open log" }))
		expect(mocks.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: "/logs/deploy.log" }))
	})

	it("shows nothing about an outcome while asking", () => {
		render(<ScriptToolRow asking info={{ ...info, outcome: undefined }} />)
		expect(screen.queryByTestId("script-outcome")).not.toBeInTheDocument()
	})
})

it("shows unreviewed command and cwd and scopes trust to the pending decision", async () => {
	render(
		<ScriptToolRow
			asking
			info={{ action: "run", name: "deploy", options: [], command: "echo reviewed", cwd: "/repo" }}
			message={{ ts: 1, type: "ask", ask: "tool", decisionId: "decision" }}
		/>,
	)
	expect(screen.getByText("echo reviewed")).toBeInTheDocument()
	expect(screen.getByText("Runs in: /repo")).toBeInTheDocument()
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Trust this version" }))
	})
	expect(mocks.askResponse).toHaveBeenCalledWith(
		expect.objectContaining({
			taskId: "thread",
			decisionId: "decision",
			responseType: "yesButtonClicked",
			text: "trust-script-version",
		}),
	)
})
