import { RefreshedScripts, ScriptInfo, ScriptOptionInfo } from "@shared/proto/cline/file"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetScriptsForTest } from "@/hooks/useScripts"
import ScriptsPanel from "./ScriptsPanel"

const mocks = vi.hoisted(() => ({
	refreshScripts: vi.fn(),
	toggleScript: vi.fn(),
	setScriptApproval: vi.fn(),
	createScriptFile: vi.fn(),
	openFile: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		refreshScripts: (request: unknown) => mocks.refreshScripts(request),
		toggleScript: (request: unknown) => mocks.toggleScript(request),
		setScriptApproval: (request: unknown) => mocks.setScriptApproval(request),
		createScriptFile: (request: unknown) => mocks.createScriptFile(request),
		openFile: (request: unknown) => mocks.openFile(request),
	},
}))

const script = (overrides: Partial<ScriptInfo> = {}) =>
	ScriptInfo.create({
		name: "test-module",
		description: "Run one module's tests",
		path: "/repo/.clinerules/scripts/test-module.md",
		enabled: true,
		approval: "ask_in_ask_mode",
		options: [ScriptOptionInfo.create({ name: "module", kind: "choice", required: true, choices: ["api"] })],
		...overrides,
	})

const response = (workspace: ScriptInfo[], global: ScriptInfo[] = []) =>
	RefreshedScripts.create({ workspaceScripts: workspace, globalScripts: global })

describe("ScriptsPanel", () => {
	beforeEach(() => {
		resetScriptsForTest()
		for (const mock of Object.values(mocks)) mock.mockReset()
		mocks.refreshScripts.mockResolvedValue(
			response(
				[script()],
				[
					script({
						name: "mm-status",
						description: "Git status",
						path: "/home/me/.cline/scripts/mm-status.md",
						approval: "always_allow",
					}),
				],
			),
		)
	})

	it("lists workspace and global scripts with description and approval", async () => {
		render(<ScriptsPanel />)
		const row = await screen.findByTestId("script-row-test-module")
		expect(row).toHaveTextContent("Run one module's tests")
		expect(screen.getByTestId("script-approval-test-module")).toHaveTextContent("Ask mode asks")
		expect(screen.getByTestId("script-approval-mm-status")).toHaveTextContent("Always allow")
		expect(screen.getByText(".clinerules/scripts/")).toBeInTheDocument()
		expect(screen.getByText("~/.cline/scripts/")).toBeInTheDocument()
		expect(screen.getByTestId("scripts-panel")).toHaveTextContent("script tool")
	})

	it("opens the file in the editor", async () => {
		mocks.openFile.mockResolvedValue({})
		render(<ScriptsPanel />)
		fireEvent.click(await screen.findByRole("button", { name: "test-module" }))
		expect(mocks.openFile).toHaveBeenCalledWith(
			expect.objectContaining({ value: "/repo/.clinerules/scripts/test-module.md" }),
		)
	})

	it("toggles a script by path and scope", async () => {
		mocks.toggleScript.mockResolvedValue(response([script({ enabled: false })]))
		render(<ScriptsPanel />)
		await screen.findByTestId("script-row-test-module")
		fireEvent.click(screen.getByRole("switch", { name: "Disable test-module" }))
		await waitFor(() =>
			expect(mocks.toggleScript).toHaveBeenCalledWith(
				expect.objectContaining({
					scriptPath: "/repo/.clinerules/scripts/test-module.md",
					isGlobal: false,
					enabled: false,
				}),
			),
		)
		await waitFor(() => expect(screen.getByRole("switch", { name: "Enable test-module" })).toBeInTheDocument())
	})

	it("global scripts toggle with isGlobal", async () => {
		mocks.toggleScript.mockResolvedValue(response([], []))
		render(<ScriptsPanel />)
		await screen.findByTestId("script-row-mm-status")
		fireEvent.click(screen.getByRole("switch", { name: "Disable mm-status" }))
		await waitFor(() => expect(mocks.toggleScript).toHaveBeenCalledWith(expect.objectContaining({ isGlobal: true })))
	})

	it("cycles the approval level through the three levels", async () => {
		mocks.setScriptApproval.mockResolvedValue(response([script({ approval: "always_allow" })]))
		render(<ScriptsPanel />)
		await screen.findByTestId("script-row-test-module")
		fireEvent.click(screen.getByTestId("script-approval-test-module"))
		await waitFor(() =>
			expect(mocks.setScriptApproval).toHaveBeenCalledWith(expect.objectContaining({ approval: "always_allow" })),
		)
		await waitFor(() => expect(screen.getByTestId("script-approval-test-module")).toHaveTextContent("Always allow"))
	})

	it("shows the errors of an invalid script and offers no approval", async () => {
		mocks.refreshScripts.mockResolvedValue(
			response([script({ name: "broken", approval: "", errors: ["command is required"], options: [] })]),
		)
		render(<ScriptsPanel onUse={vi.fn()} />)
		expect(await screen.findByTestId("script-errors-broken")).toHaveTextContent("command is required")
		expect(screen.queryByTestId("script-approval-broken")).not.toBeInTheDocument()
		expect(screen.queryByTestId("script-use-broken")).not.toBeInTheDocument()
	})

	it("offers Use for enabled scripts only when a handler is given", async () => {
		const onUse = vi.fn()
		render(<ScriptsPanel onUse={onUse} />)
		fireEvent.click(await screen.findByTestId("script-use-test-module"))
		expect(onUse).toHaveBeenCalledWith("test-module")
	})

	it("creates a script from the New script row", async () => {
		mocks.createScriptFile.mockResolvedValue(
			response([script(), script({ name: "fresh", path: "/repo/.clinerules/scripts/fresh.md" })]),
		)
		render(<ScriptsPanel />)
		await screen.findByTestId("script-row-test-module")
		const input = screen.getAllByPlaceholderText("New script...")[0]
		fireEvent.click(input)
		const expanded = screen.getAllByPlaceholderText("script-name (letters, numbers, dashes, underscores)")[0]
		await act(async () => {
			fireEvent.change(expanded, { target: { value: "fresh" } })
			fireEvent.submit(expanded.closest("form") as HTMLFormElement)
		})
		await waitFor(() =>
			expect(mocks.createScriptFile).toHaveBeenCalledWith(
				expect.objectContaining({ scriptName: "fresh", isGlobal: false }),
			),
		)
		expect(await screen.findByTestId("script-row-fresh")).toBeInTheDocument()
	})

	it("rejects names it cannot type as /name", async () => {
		render(<ScriptsPanel />)
		await screen.findByTestId("script-row-test-module")
		fireEvent.click(screen.getAllByPlaceholderText("New script...")[0])
		const expanded = screen.getAllByPlaceholderText("script-name (letters, numbers, dashes, underscores)")[0]
		await act(async () => {
			fireEvent.change(expanded, { target: { value: "bad name" } })
			fireEvent.submit(expanded.closest("form") as HTMLFormElement)
		})
		expect(mocks.createScriptFile).not.toHaveBeenCalled()
		expect(screen.getByText(/Script name can only contain/)).toBeInTheDocument()
	})
	it("shows unreviewed definitions and trusts the displayed fingerprint", async () => {
		mocks.refreshScripts.mockResolvedValue(
			response([script({ trusted: false, fingerprint: "version-1", command: "echo review", cwd: "/repo" })]),
		)
		mocks.setScriptApproval.mockResolvedValue(response([script({ trusted: true })]))
		render(<ScriptsPanel />)
		expect(await screen.findByText("Unreviewed")).toBeInTheDocument()
		expect(screen.getByText("echo review")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Trust this version" }))
		await waitFor(() =>
			expect(mocks.setScriptApproval).toHaveBeenCalledWith(
				expect.objectContaining({ fingerprint: "version-1", trustOnly: true }),
			),
		)
		await waitFor(() => expect(screen.queryByText("Unreviewed")).not.toBeInTheDocument())
	})
})
