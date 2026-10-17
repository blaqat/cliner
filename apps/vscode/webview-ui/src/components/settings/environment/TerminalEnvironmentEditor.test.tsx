import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TerminalEnvironmentEditor from "./TerminalEnvironmentEditor"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	update: vi.fn(),
	resolveTerminalEnvironment: vi.fn(),
	revealTerminalEnvironment: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: mocks.update }))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: {
		resolveTerminalEnvironment: mocks.resolveTerminalEnvironment,
		revealTerminalEnvironment: mocks.revealTerminalEnvironment,
	},
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, onInput, onBlur, value, placeholder, type, ...rest }: any) => (
		<label>
			{children}
			<input
				aria-label={rest["aria-label"]}
				id={rest.id}
				onBlur={onBlur}
				onChange={onInput}
				placeholder={placeholder}
				type={type}
				value={value}
			/>
		</label>
	),
	VSCodeButton: ({ children, onClick, disabled }: any) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeDropdown: ({ children, onChange, value, ...rest }: any) => (
		<select aria-label={rest["aria-label"]} onChange={onChange} value={value}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: { children?: ReactNode; value: string }) => <option value={value}>{children}</option>,
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

describe("TerminalEnvironmentEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Webview state carries names + masked placeholders only.
		mocks.state = {
			terminalEnvironment: {
				global: {
					variables: { GITHUB_TOKEN: "__cline_terminal_env_unchanged__", EDITOR: "__cline_terminal_env_unchanged__" },
					envFilePath: "/tmp/prod.env",
					pathEntries: ["/opt/bin"],
				},
				workspace: { variables: { NODE_ENV: "__cline_terminal_env_unchanged__" } },
			},
		}
		mocks.revealTerminalEnvironment.mockImplementation(async (request: { value: boolean }) => ({
			variables: request.value ? { NODE_ENV: "test" } : { GITHUB_TOKEN: "ghp_secret", EDITOR: "vim" },
		}))
		mocks.resolveTerminalEnvironment.mockResolvedValue({
			variables: [
				{ name: "NODE_ENV", source: "workspace", overriddenSource: "global" },
				{ name: "EDITOR", source: "global" },
			],
		})
	})

	it("never renders stored values until the eye toggle reveals the scope", async () => {
		const { container } = render(<TerminalEnvironmentEditor />)
		const secret = screen.getByLabelText("Value for GITHUB_TOKEN") as HTMLInputElement
		expect(secret.type).toBe("password")
		expect(secret.value).toBe("")
		expect(secret.placeholder).toBeTruthy()
		expect(container.innerHTML).not.toContain("ghp_secret")
		expect(mocks.revealTerminalEnvironment).not.toHaveBeenCalled()

		fireEvent.click(screen.getByLabelText("Show environment values"))
		await waitFor(() =>
			expect((screen.getByLabelText("Value for GITHUB_TOKEN") as HTMLInputElement).value).toBe("ghp_secret"),
		)
		expect(mocks.revealTerminalEnvironment).toHaveBeenCalledWith(expect.objectContaining({ value: false }))
		expect((screen.getByLabelText("Value for GITHUB_TOKEN") as HTMLInputElement).type).toBe("text")
		expect((screen.getByLabelText("Value for EDITOR") as HTMLInputElement).value).toBe("vim")

		// Hiding drops the revealed values from the editor's state.
		fireEvent.click(screen.getByLabelText("Hide environment values"))
		expect((screen.getByLabelText("Value for GITHUB_TOKEN") as HTMLInputElement).value).toBe("")
		expect(container.innerHTML).not.toContain("ghp_secret")
	})

	it("reveals only the visible scope and drops values when the scope changes", async () => {
		render(<TerminalEnvironmentEditor />)
		fireEvent.click(screen.getByLabelText("Show environment values"))
		await screen.findByDisplayValue("ghp_secret")
		fireEvent.click(screen.getByText("Workspace"))
		expect(screen.queryByDisplayValue("ghp_secret")).toBeNull()
		expect((screen.getByLabelText("Value for NODE_ENV") as HTMLInputElement).value).toBe("")
		fireEvent.click(screen.getByLabelText("Show environment values"))
		await screen.findByDisplayValue("test")
		expect(mocks.revealTerminalEnvironment).toHaveBeenLastCalledWith(expect.objectContaining({ value: true }))
	})

	it("switches between global and workspace scopes", () => {
		render(<TerminalEnvironmentEditor />)
		expect(screen.getByLabelText("Value for GITHUB_TOKEN")).toBeTruthy()
		fireEvent.click(screen.getByText("Workspace"))
		expect(screen.queryByLabelText("Value for GITHUB_TOKEN")).toBeNull()
		expect(screen.getByLabelText("Value for NODE_ENV")).toBeTruthy()
	})

	it("commits an edited value as a patch for that variable only", () => {
		render(<TerminalEnvironmentEditor />)
		const editor = screen.getByLabelText("Value for EDITOR")
		fireEvent.change(editor, { target: { value: "nano" } })
		fireEvent.blur(editor)
		expect(mocks.update).toHaveBeenCalledTimes(1)
		expect(mocks.update).toHaveBeenCalledWith(
			"terminalEnvironment",
			expect.objectContaining({
				workspace: false,
				setVariables: { EDITOR: "nano" },
				removeVariables: [],
				envFilePath: undefined,
				addPathEntries: [],
				removePathEntries: [],
			}),
		)
	})

	it("does not write anything when a masked value is focused and left untouched", () => {
		render(<TerminalEnvironmentEditor />)
		fireEvent.blur(screen.getByLabelText("Value for GITHUB_TOKEN"))
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it("sends blur-save then Remove as two independent patches", () => {
		render(<TerminalEnvironmentEditor />)
		const editor = screen.getByLabelText("Value for EDITOR")
		fireEvent.change(editor, { target: { value: "nano" } })
		fireEvent.blur(editor)
		fireEvent.click(screen.getByLabelText("Remove GITHUB_TOKEN"))
		expect(mocks.update).toHaveBeenCalledTimes(2)
		expect(mocks.update.mock.calls[0][1]).toMatchObject({ setVariables: { EDITOR: "nano" }, removeVariables: [] })
		expect(mocks.update.mock.calls[1][1]).toMatchObject({ setVariables: {}, removeVariables: ["GITHUB_TOKEN"] })
	})

	it("adds a variable to the workspace scope only", () => {
		render(<TerminalEnvironmentEditor />)
		fireEvent.click(screen.getByText("Workspace"))
		fireEvent.change(screen.getByLabelText("New workspace variable name"), { target: { value: "EXTRA" } })
		fireEvent.change(screen.getByLabelText("New workspace variable value"), { target: { value: "1" } })
		fireEvent.click(screen.getByLabelText("Add workspace variable"))
		expect(mocks.update).toHaveBeenCalledWith(
			"terminalEnvironment",
			expect.objectContaining({ workspace: true, setVariables: { EXTRA: "1" } }),
		)
	})

	it("patches PATH entries one at a time", () => {
		render(<TerminalEnvironmentEditor />)
		fireEvent.change(screen.getByLabelText("New global PATH entry"), { target: { value: "/usr/local/x" } })
		fireEvent.click(screen.getByLabelText("Add global PATH entry"))
		fireEvent.click(screen.getByLabelText("Remove PATH entry /opt/bin"))
		expect(mocks.update.mock.calls[0][1]).toMatchObject({ addPathEntries: ["/usr/local/x"], removePathEntries: [] })
		expect(mocks.update.mock.calls[1][1]).toMatchObject({ addPathEntries: [], removePathEntries: ["/opt/bin"] })
	})

	it("explains and refuses a relative global .env path, but allows ~ and absolute", () => {
		render(<TerminalEnvironmentEditor />)
		const field = screen.getByLabelText(".env file path (optional)")
		fireEvent.change(field, { target: { value: ".env" } })
		expect(screen.getByRole("alert").textContent).toContain("absolute or start with ~")
		fireEvent.blur(field)
		expect(mocks.update).not.toHaveBeenCalled()

		fireEvent.change(field, { target: { value: "~/secrets/dev.env" } })
		expect(screen.queryByRole("alert")).toBeNull()
		fireEvent.blur(field)
		expect(mocks.update).toHaveBeenCalledWith(
			"terminalEnvironment",
			expect.objectContaining({ workspace: false, envFilePath: "~/secrets/dev.env" }),
		)
	})

	it("allows a relative .env path in the workspace scope and says what it resolves against", () => {
		render(<TerminalEnvironmentEditor />)
		fireEvent.click(screen.getByText("Workspace"))
		const field = screen.getByLabelText(".env file path (optional)")
		expect(screen.getByText(/resolve against the workspace root/)).toBeTruthy()
		fireEvent.change(field, { target: { value: ".env.local" } })
		fireEvent.blur(field)
		expect(mocks.update).toHaveBeenCalledWith(
			"terminalEnvironment",
			expect.objectContaining({ workspace: true, envFilePath: ".env.local" }),
		)
	})

	it("shows resolved sources without values in the collapsed preview", async () => {
		render(<TerminalEnvironmentEditor />)
		const details = screen.getByText("Resolved environment").closest("details") as HTMLDetailsElement
		details.open = true
		fireEvent(details, new Event("toggle"))
		await waitFor(() => expect(mocks.resolveTerminalEnvironment).toHaveBeenCalled())
		await screen.findByText("NODE_ENV")
		expect(screen.getByText(/workspace overrides global/)).toBeTruthy()
		// Values never appear in the preview.
		expect(screen.queryByText("ghp_secret")).toBeNull()
	})
})
