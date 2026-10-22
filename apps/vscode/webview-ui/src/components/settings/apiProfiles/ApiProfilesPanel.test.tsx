import { ALLOWED_API_PROVIDERS } from "@shared/api-profiles"
import { ApiConfigProfile } from "@shared/proto/cline/models"
import { OPENAI_REASONING_EFFORT_OPTIONS } from "@shared/storage/types"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ApiProfileEditor from "./ApiProfileEditor"
import ApiProfilesPanel from "./ApiProfilesPanel"
import { newProfileDraft } from "./profileDraft"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	listApiProfiles: vi.fn(),
	saveApiProfile: vi.fn(),
	deleteApiProfile: vi.fn(),
	assignApiProfile: vi.fn(),
	updateSettings: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		listApiProfiles: mocks.listApiProfiles,
		saveApiProfile: mocks.saveApiProfile,
		deleteApiProfile: mocks.deleteApiProfile,
		assignApiProfile: mocks.assignApiProfile,
	},
	StateServiceClient: { updateSettings: mocks.updateSettings },
}))
vi.mock("@/hooks/useProviderModels", () => ({
	useProviderModels: () => ({ models: { "claude-x": {}, "claude-y": {} }, defaultModelId: "claude-x" }),
}))
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
	VSCodeCheckbox: ({ children }: any) => <label>{children}</label>,
}))

const profiles = [
	{ id: "a", name: "Claude", provider: "anthropic", modelId: "claude-x" },
	{ id: "b", name: "Local", provider: "openai", modelId: "qwen", openAiCompatibleApiType: "responses" },
]

const card = (name: string) => screen.getAllByText(name).find((el) => el.tagName === "B") as HTMLElement

describe("ApiProfilesPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.state = {
			apiConfigProfiles: profiles,
			askProfileId: "a",
			actProfileId: "b",
			// Named profiles (Settings › Profiles) running on configuration "a".
			profiles: [{ id: "p1", name: "Deep review", configurationId: "a", reasoningEffort: "high" }],
		}
		mocks.listApiProfiles.mockResolvedValue({
			profiles: [
				ApiConfigProfile.create({
					id: "a",
					name: "Claude",
					provider: "anthropic",
					modelId: "claude-x",
					secretKeys: ["apiKey"],
				}),
				ApiConfigProfile.create({
					id: "b",
					name: "Local",
					provider: "openai",
					modelId: "qwen",
					openAiCompatibleApiType: "responses",
					optionsJson: JSON.stringify({ openAiBaseUrl: "http://l/v1" }),
				}),
			],
		})
		mocks.saveApiProfile.mockImplementation(async (req: any) => ({ profile: { id: req.id || "new" } }))
		mocks.assignApiProfile.mockResolvedValue({})
		mocks.deleteApiProfile.mockResolvedValue({})
		mocks.updateSettings.mockResolvedValue({})
	})

	it("edits the default effort without assigning the configuration", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.click(card("Claude"))
		const selector = await screen.findByLabelText("Default reasoning effort")
		expect(Array.from((selector as HTMLSelectElement).options).map((option) => option.value)).toEqual(
			OPENAI_REASONING_EFFORT_OPTIONS,
		)
		fireEvent.change(selector, { target: { value: "xhigh" } })
		fireEvent.click(screen.getByText("Save"))
		await waitFor(() =>
			expect(mocks.saveApiProfile).toHaveBeenCalledWith(expect.objectContaining({ id: "a", reasoningEffort: "xhigh" })),
		)
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
	})

	it("lists cards with provider · model · API type and no Ask/Act assignment", () => {
		render(<ApiProfilesPanel />)
		expect(screen.getByText("OpenAI Compatible · qwen · Responses")).toBeTruthy()
		expect(screen.getByText("Anthropic · claude-x")).toBeTruthy()
		expect(screen.getByText("API Configurations")).toBeTruthy()
		// Ask/Act defaults live on the Profiles page now.
		expect(screen.queryByLabelText("Ask configuration")).toBeNull()
		expect(screen.queryByText("Ask")).toBeNull()
		expect(screen.queryByText("Act")).toBeNull()
	})

	it("disables Delete for a configuration a profile runs on and explains why", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.click(card("Claude"))
		await screen.findByText("Configurations")
		expect((screen.getByText("Delete") as HTMLButtonElement).disabled).toBe(true)
		expect(screen.getByText(/Used by "Deep review"/)).toBeTruthy()
	})

	it("deletes a configuration no profile uses, even if a mode currently runs it", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.click(card("Local"))
		await screen.findByText("Configurations")
		fireEvent.click(screen.getByText("Delete"))
		await waitFor(() => expect(mocks.deleteApiProfile).toHaveBeenCalled())
		expect(mocks.deleteApiProfile.mock.calls[0][0]).toMatchObject({ id: "b" })
	})

	it("saves edits with blank secrets unchanged without reassigning the modes using it", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.click(card("Claude"))
		await screen.findByText("Configurations")
		fireEvent.change(screen.getByTestId("profile-name"), { target: { value: "Claude 2" } })
		fireEvent.click(screen.getByText("Save"))
		await waitFor(() => expect(mocks.saveApiProfile).toHaveBeenCalled())
		const request = mocks.saveApiProfile.mock.calls[0][0]
		expect(request).toMatchObject({ id: "a", name: "Claude 2", provider: "anthropic", modelId: "claude-x" })
		expect(request.secrets).toEqual({})
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
	})

	it("creates a new configuration with options_json and typed secrets", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.click(screen.getByText("+ New"))
		fireEvent.change(screen.getByTestId("profile-name"), { target: { value: "Mine" } })
		fireEvent.change(screen.getByTestId("option-openAiBaseUrl"), { target: { value: "http://x/v1" } })
		fireEvent.change(screen.getByTestId("secret-openAiApiKey"), { target: { value: "sk-1" } })
		fireEvent.change(screen.getByTestId("model-id-input"), { target: { value: "m1" } })
		fireEvent.click(screen.getByText("Create"))
		await waitFor(() => expect(mocks.saveApiProfile).toHaveBeenCalled())
		const request = mocks.saveApiProfile.mock.calls[0][0]
		expect(request.id).toBe("")
		expect(JSON.parse(request.optionsJson)).toEqual({ openAiBaseUrl: "http://x/v1" })
		expect(request.secrets).toEqual({ openAiApiKey: "sk-1" })
		expect(mocks.assignApiProfile).not.toHaveBeenCalled()
	})

	it("does not save without a name or model", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.click(screen.getByText("+ New"))
		fireEvent.click(screen.getByText("Create"))
		expect(await screen.findByText("Name is required.")).toBeTruthy()
		expect(mocks.saveApiProfile).not.toHaveBeenCalled()
	})
})

describe("ApiProfileEditor default effort", () => {
	it.each(ALLOWED_API_PROVIDERS)("offers the bottom-bar effort options for %s", (provider) => {
		const onChange = vi.fn()
		render(<ApiProfileEditor draft={newProfileDraft(provider)} onChange={onChange} onSave={vi.fn()} usedBy={[]} />)
		const selector = screen.getByLabelText("Default reasoning effort") as HTMLSelectElement
		expect(Array.from(selector.options).map((option) => option.value)).toEqual(OPENAI_REASONING_EFFORT_OPTIONS)
		expect(selector.value).toBe("none")
		fireEvent.change(selector, { target: { value: "high" } })
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider, reasoningEffort: "high" }))
	})
})
