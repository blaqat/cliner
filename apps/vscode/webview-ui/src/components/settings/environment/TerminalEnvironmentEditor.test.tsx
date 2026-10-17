import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TerminalEnvironmentEditor from "./TerminalEnvironmentEditor"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	update: vi.fn(),
	resolveTerminalEnvironment: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: mocks.update }))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { resolveTerminalEnvironment: mocks.resolveTerminalEnvironment },
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
		mocks.state = {
			terminalEnvironment: {
				global: {
					variables: { GITHUB_TOKEN: "ghp_secret", EDITOR: "vim" },
					envFilePath: "/tmp/prod.env",
					pathEntries: ["/opt/bin"],
				},
				workspace: { variables: { NODE_ENV: "test" } },
			},
		}
		mocks.resolveTerminalEnvironment.mockResolvedValue({
			variables: [
				{ name: "NODE_ENV", source: "workspace", overriddenSource: "global" },
				{ name: "EDITOR", source: "global" },
			],
		})
	})

	it("masks variable values behind a single eye toggle", () => {
		render(<TerminalEnvironmentEditor />)
		const secret = screen.getByLabelText("Value for GITHUB_TOKEN") as HTMLInputElement
		const editor = screen.getByLabelText("Value for EDITOR") as HTMLInputElement
		expect(secret.type).toBe("password")
		expect(editor.type).toBe("password")
		// One toggle reveals every value field.
		fireEvent.click(screen.getByLabelText("Show environment values"))
		expect(secret.type).toBe("text")
		expect(editor.type).toBe("text")
		fireEvent.click(screen.getByLabelText("Hide environment values"))
		expect(secret.type).toBe("password")
		expect(editor.type).toBe("password")
	})

	it("switches between global and workspace scopes", () => {
		render(<TerminalEnvironmentEditor />)
		expect(screen.getByLabelText("Value for GITHUB_TOKEN")).toBeTruthy()
		fireEvent.click(screen.getByText("Workspace"))
		expect(screen.queryByLabelText("Value for GITHUB_TOKEN")).toBeNull()
		expect(screen.getByLabelText("Value for NODE_ENV")).toBeTruthy()
	})

	it("commits an edited value for the active scope", () => {
		render(<TerminalEnvironmentEditor />)
		const editor = screen.getByLabelText("Value for EDITOR")
		fireEvent.change(editor, { target: { value: "nano" } })
		fireEvent.blur(editor)
		expect(mocks.update).toHaveBeenCalledWith(
			"terminalEnvironment",
			expect.objectContaining({
				workspace: false,
				variables: { GITHUB_TOKEN: "ghp_secret", EDITOR: "nano" },
				envFilePath: "/tmp/prod.env",
				pathEntries: ["/opt/bin"],
			}),
		)
	})

	it("adds a variable to the workspace scope only", () => {
		render(<TerminalEnvironmentEditor />)
		fireEvent.click(screen.getByText("Workspace"))
		fireEvent.change(screen.getByLabelText("New workspace variable name"), { target: { value: "EXTRA" } })
		fireEvent.change(screen.getByLabelText("New workspace variable value"), { target: { value: "1" } })
		fireEvent.click(screen.getByLabelText("Add workspace variable"))
		expect(mocks.update).toHaveBeenCalledWith(
			"terminalEnvironment",
			expect.objectContaining({ workspace: true, variables: { NODE_ENV: "test", EXTRA: "1" } }),
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
