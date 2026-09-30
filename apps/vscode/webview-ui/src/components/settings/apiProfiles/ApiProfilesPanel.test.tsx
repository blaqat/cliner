import { ApiConfigProfile } from "@shared/proto/cline/models"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ApiProfilesPanel from "./ApiProfilesPanel"

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
			planActSeparateModelsSetting: true,
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

	it("lists cards with provider · model · API type and mode badges", () => {
		render(<ApiProfilesPanel />)
		expect(screen.getByText("OpenAI Compatible · qwen · Responses")).toBeTruthy()
		expect(screen.getByText("Anthropic · claude-x")).toBeTruthy()
		expect(screen.getByText("Ask")).toBeTruthy()
		expect(screen.getByText("Act")).toBeTruthy()
	})

	it("assigns a configuration to a mode", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.change(screen.getByLabelText("Ask configuration"), { target: { value: "b" } })
		await waitFor(() => expect(mocks.assignApiProfile).toHaveBeenCalled())
		expect(mocks.assignApiProfile.mock.calls[0][0]).toMatchObject({ mode: "plan", profileId: "b" })
	})

	it("disables Delete for an assigned configuration and explains why", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.click(card("Claude"))
		await screen.findByText("Configurations")
		expect((screen.getByText("Delete") as HTMLButtonElement).disabled).toBe(true)
		expect(screen.getByText(/Used by Ask/)).toBeTruthy()
	})

	it("deletes an unassigned configuration", async () => {
		mocks.state = { ...mocks.state, actProfileId: "a" }
		render(<ApiProfilesPanel />)
		fireEvent.click(card("Local"))
		await screen.findByText("Configurations")
		fireEvent.click(screen.getByText("Delete"))
		await waitFor(() => expect(mocks.deleteApiProfile).toHaveBeenCalled())
		expect(mocks.deleteApiProfile.mock.calls[0][0]).toMatchObject({ id: "b" })
	})

	it("saves edits with blank secrets unchanged and re-assigns the modes using it", async () => {
		render(<ApiProfilesPanel />)
		fireEvent.click(card("Claude"))
		await screen.findByText("Configurations")
		fireEvent.change(screen.getByTestId("profile-name"), { target: { value: "Claude 2" } })
		fireEvent.click(screen.getByText("Save"))
		await waitFor(() => expect(mocks.saveApiProfile).toHaveBeenCalled())
		const request = mocks.saveApiProfile.mock.calls[0][0]
		expect(request).toMatchObject({ id: "a", name: "Claude 2", provider: "anthropic", modelId: "claude-x" })
		expect(request.secrets).toEqual({})
		await waitFor(() => expect(mocks.assignApiProfile).toHaveBeenCalledTimes(1))
		expect(mocks.assignApiProfile.mock.calls[0][0]).toMatchObject({ mode: "plan", profileId: "a" })
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
