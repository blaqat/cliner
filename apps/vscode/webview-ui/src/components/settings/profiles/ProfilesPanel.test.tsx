import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ProfilesPanel from "./ProfilesPanel"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	updateSettings: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({ StateServiceClient: { updateSettings: mocks.updateSettings } }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, disabled, onClick, ...rest }: any) => (
		<button aria-label={rest["aria-label"]} disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeDropdown: ({ children, onChange, value, ...rest }: any) => (
		<select aria-label={rest["aria-label"]} id={rest.id} onChange={onChange} value={value}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: { children?: ReactNode; value: string }) => <option value={value}>{children}</option>,
	VSCodeTextField: ({ children, onInput, value, placeholder, ...rest }: any) => (
		<label>
			{children}
			<input data-testid={rest["data-testid"]} onChange={onInput} placeholder={placeholder} value={value} />
		</label>
	),
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

const configurations = [
	{ id: "cfg-claude", name: "Claude", provider: "anthropic", modelId: "claude-x", reasoningEffort: "high" },
	{ id: "cfg-local", name: "Local", provider: "openai", modelId: "qwen" },
]
const profiles = [
	{ id: "fast", name: "Fast", configurationId: "cfg-local", reasoningEffort: "low" },
	{ id: "deep", name: "Deep", configurationId: "cfg-claude", reasoningEffort: "xhigh" },
]

// Radix Select measures and captures the pointer; jsdom has neither.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.scrollIntoView ??= () => {}

/** Picks an option in one of the section's profile selects. */
const pick = async (name: string, option: string) => {
	fireEvent.keyDown(screen.getByRole("combobox", { name }), { key: "Enter" })
	fireEvent.keyDown(await screen.findByRole("option", { name: option }), { key: "Enter" })
}
const selected = (name: string) => screen.getByRole("combobox", { name }).textContent

/** The last updateSettings request. */
const lastRequest = () => mocks.updateSettings.mock.calls.at(-1)?.[0]
const card = (name: string) => screen.getAllByText(name).find((el) => el.tagName === "B") as HTMLElement

describe("ProfilesPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.updateSettings.mockResolvedValue({})
		mocks.state = {
			apiConfigProfiles: configurations,
			profiles,
			threadDefaultProfileId: "fast",
			threadSeparateAskActProfiles: false,
		}
	})

	it("lists profiles with their model and effort, then the Thread, Subagents and Text generation sections", () => {
		render(<ProfilesPanel />)
		expect(screen.getByText("Local · Low")).toBeTruthy()
		expect(screen.getByText("Claude · Xhigh")).toBeTruthy()
		// Laid out like the stock settings groups: heading, description, a bordered card of fields.
		const groups = screen.getAllByRole("region").map((el) => el.getAttribute("aria-label"))
		expect(groups).toEqual(["Thread", "Subagents", "Text generation"])
		expect(screen.queryByText(/Used by/)).toBeNull()
	})

	it("creates a profile inline from a configuration and an effort", async () => {
		render(<ProfilesPanel />)
		fireEvent.click(screen.getByText("+ New"))
		const editor = screen.getByTestId("profile-editor")
		fireEvent.change(within(editor).getByTestId("profile-editor-name"), { target: { value: "Quick Claude" } })
		fireEvent.change(within(editor).getByLabelText("Profile model"), { target: { value: "cfg-claude" } })
		fireEvent.change(within(editor).getByLabelText("Profile reasoning effort"), { target: { value: "medium" } })
		fireEvent.click(within(editor).getByText("Create"))
		await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalled())
		expect(lastRequest().profiles.values).toEqual([
			expect.objectContaining({ id: "fast", name: "Fast", configurationId: "cfg-local", reasoningEffort: "low" }),
			expect.objectContaining({ id: "deep", name: "Deep", configurationId: "cfg-claude", reasoningEffort: "xhigh" }),
			expect.objectContaining({ id: "", name: "Quick Claude", configurationId: "cfg-claude", reasoningEffort: "medium" }),
		])
	})

	it("edits a profile in place", async () => {
		render(<ProfilesPanel />)
		fireEvent.click(card("Deep"))
		const editor = screen.getByTestId("profile-editor")
		fireEvent.change(within(editor).getByLabelText("Profile reasoning effort"), { target: { value: "medium" } })
		fireEvent.click(within(editor).getByText("Save"))
		await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalled())
		expect(lastRequest().profiles.values[1]).toMatchObject({ id: "deep", reasoningEffort: "medium" })
		await waitFor(() => expect(screen.queryByTestId("profile-editor")).toBeNull())
	})

	it("deletes a profile, but not one new threads start on", async () => {
		render(<ProfilesPanel />)
		fireEvent.click(card("Fast"))
		expect((within(screen.getByTestId("profile-editor")).getByText("Delete") as HTMLButtonElement).disabled).toBe(true)
		expect(screen.getByText(/Choose another Thread default to delete it/)).toBeTruthy()
		fireEvent.click(screen.getByText("Cancel"))

		fireEvent.click(card("Deep"))
		fireEvent.click(within(screen.getByTestId("profile-editor")).getByText("Delete"))
		await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalled())
		expect(lastRequest().profiles.values.map((p: { id: string }) => p.id)).toEqual(["fast"])
	})

	describe("Thread defaults switch", () => {
		it("is off by default with one Default picker", () => {
			render(<ProfilesPanel />)
			expect(screen.getByRole("switch", { name: "Different profile for Ask and Act" }).getAttribute("aria-checked")).toBe(
				"false",
			)
			expect(selected("Thread default profile")).toBe("Fast")
			expect(screen.queryByRole("combobox", { name: "Ask default profile" })).toBeNull()
		})

		it("sets the shared default", async () => {
			render(<ProfilesPanel />)
			await pick("Thread default profile", "Deep")
			await waitFor(() => expect(lastRequest()).toMatchObject({ threadDefaultProfileId: "deep" }))
		})

		it("turning it on starts Ask and Act on the current default", async () => {
			render(<ProfilesPanel />)
			fireEvent.click(screen.getByRole("switch", { name: "Different profile for Ask and Act" }))
			await waitFor(() =>
				expect(lastRequest()).toMatchObject({
					threadSeparateAskActProfiles: true,
					threadAskProfileId: "fast",
					threadActProfileId: "fast",
				}),
			)
		})

		it("shows Ask and Act pickers when on, and turning it off keeps Act's profile", async () => {
			mocks.state = {
				...mocks.state,
				threadSeparateAskActProfiles: true,
				threadAskProfileId: "deep",
				threadActProfileId: "fast",
			}
			render(<ProfilesPanel />)
			expect(selected("Ask default profile")).toBe("Deep")
			expect(selected("Act default profile")).toBe("Fast")
			await pick("Ask default profile", "Fast")
			await waitFor(() => expect(lastRequest()).toMatchObject({ threadAskProfileId: "fast" }))
			fireEvent.click(screen.getByRole("switch", { name: "Different profile for Ask and Act" }))
			await waitFor(() =>
				expect(lastRequest()).toMatchObject({ threadSeparateAskActProfiles: false, threadDefaultProfileId: "fast" }),
			)
		})
	})

	it("Subagents: toggle, default profile and allowed profiles", async () => {
		mocks.state = { ...mocks.state, subagentProfilesEnabled: true, subagentAllowedProfileIds: ["parent"] }
		render(<ProfilesPanel />)
		expect(selected("Subagent default profile")).toBe("Same as thread")
		await pick("Subagent default profile", "Deep")
		await waitFor(() => expect(lastRequest()).toMatchObject({ subagentDefaultProfileId: "deep" }))
		fireEvent.click(screen.getAllByText("Deep").find((el) => el.tagName === "LABEL") as HTMLElement)
		await waitFor(() => expect(lastRequest()).toMatchObject({ subagentAllowedProfileIds: { values: ["parent", "deep"] } }))
		fireEvent.click(screen.getByRole("switch", { name: "Let subagents use profiles" }))
		await waitFor(() => expect(lastRequest()).toMatchObject({ subagentProfilesEnabled: false }))
	})

	it("Text generation: walkthrough profile and thread titles (off by default)", async () => {
		render(<ProfilesPanel />)
		expect(selected("Walkthrough Generate profile")).toBe("Choose a profile")
		await pick("Walkthrough Generate profile", "Deep")
		await waitFor(() => expect(lastRequest()).toMatchObject({ walkthroughGenerateProfileId: "deep" }))
		expect(screen.queryByRole("combobox", { name: "Thread title profile" })).toBeNull()
		fireEvent.click(screen.getByRole("switch", { name: "Name new threads automatically" }))
		await waitFor(() => expect(lastRequest()).toMatchObject({ threadTitlesEnabled: true }))
	})
})
