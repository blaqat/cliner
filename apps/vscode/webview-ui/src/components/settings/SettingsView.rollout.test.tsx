import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
import SettingsView from "./SettingsView"

// The old tabs read this once, at import.
vi.hoisted(() => {
	process.env.IS_DEV = ""
})

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	auth: { activeOrganization: null, clineUser: null } as Record<string, unknown>,
	internal: vi.fn(() => false),
	retry: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => mocks.auth }))
vi.mock("@/components/navigation/NavigationHistoryContext", () => ({ useNavigationHistory: () => undefined }))
vi.mock("@/components/common/ViewHeader", () => ({ default: () => <div>Settings</div> }))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: {},
	ModelsServiceClient: { retryModelSettingsMigration: mocks.retry },
}))
vi.mock("@shared/internal/account", () => ({ isClineInternalTester: mocks.internal }))
vi.mock("./sections/ApiConfigurationSection", () => ({ default: () => <div>api configuration panel</div> }))
vi.mock("./sections/ProfilesSection", () => ({ default: () => <div>profiles panel</div> }))
vi.mock("./sections/AboutSection", () => ({ default: () => <div>about panel</div> }))
vi.mock("./sections/DebugSection", () => ({ default: () => <div>debug panel</div> }))
vi.mock("./sections/FeatureSettingsSection", () => ({ default: () => <div>feature panel</div> }))
vi.mock("./sections/GeneralSettingsSection", () => ({ default: () => <div>general panel</div> }))
vi.mock("./sections/SubagentsSettingsSection", () => ({ default: () => <div>subagents panel</div> }))
vi.mock("./sections/TerminalSettingsSection", () => ({ default: () => <div>terminal panel</div> }))
vi.mock("./sections/RemoteConfigSection", () => ({ RemoteConfigSection: () => <div>remote config panel</div> }))
vi.mock("./environment/TerminalEnvironmentEditor", () => ({ default: () => null }))
vi.mock("@/components/worktrees/WorktreeSettings", () => ({ WorktreeSettings: () => null }))

const tabs = () => screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-value"))

beforeEach(() => {
	mocks.internal.mockReturnValue(false)
	mocks.auth = { activeOrganization: null, clineUser: null }
	mocks.state = { remoteConfigSettings: {}, availableTerminalProfiles: [], platform: "darwin" }
})

describe("with modelSettings absent", () => {
	it("is today's Settings, tab for tab", () => {
		render(<SettingsView onDone={() => {}} />)
		expect(tabs()).toEqual(["api-config", "profiles", "features", "subagents", "terminal", "general", "about"])
		expect(screen.getByText("api configuration panel")).toBeInTheDocument()
		expect(screen.queryByLabelText("Search settings")).toBeNull()
		expect(screen.queryByRole("button", { name: /^Changed/ })).toBeNull()
	})

	it("keeps today's targets", () => {
		render(<SettingsView navigationRequest={{ target: "mcp-advanced", requestId: 1 }} onDone={() => {}} />)
		expect(screen.getByText("feature panel")).toBeInTheDocument()
	})

	it("keeps the Remote Config tab for admins", () => {
		mocks.auth = { activeOrganization: { roles: ["admin"] }, clineUser: null }
		render(<SettingsView onDone={() => {}} />)
		expect(tabs()).toContain("remote-config")
	})

	it("keeps today's Debug rule, internal testers included", () => {
		mocks.internal.mockReturnValue(true)
		mocks.auth = { activeOrganization: null, clineUser: { email: "tester@example.com" } }
		render(<SettingsView onDone={() => {}} />)
		expect(tabs()).toContain("debug")
	})
})

describe("when the first move of model settings failed", () => {
	const failed = { status: "failed", retryable: true, cause: "Could not write to the connection keychain" }

	it("says why on the old Settings and retries with the existing RPC", async () => {
		mocks.state = { ...mocks.state, modelSettingsMigrationStatus: failed }
		mocks.retry.mockResolvedValue({ json: JSON.stringify({ status: "complete", retryable: false }) })
		render(<SettingsView onDone={() => {}} />)
		expect(screen.getByText(/Models could not be moved/)).toBeInTheDocument()
		expect(screen.getByText("Could not write to the connection keychain")).toBeInTheDocument()
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Retry migration" }))
		})
		expect(mocks.retry).toHaveBeenCalledWith({ json: "{}" })
	})

	it("says so when the retry itself can't reach the host", async () => {
		mocks.state = { ...mocks.state, modelSettingsMigrationStatus: failed }
		mocks.retry.mockRejectedValue(new Error("no"))
		render(<SettingsView onDone={() => {}} />)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Retry migration" }))
		})
		expect(screen.getByRole("alert")).toHaveTextContent(/could not finish/)
	})

	it.each(["pending", "complete", "disabled"])("shows nothing while it's %s", (status) => {
		mocks.state = { ...mocks.state, modelSettingsMigrationStatus: { status, retryable: false } }
		render(<SettingsView onDone={() => {}} />)
		expect(screen.queryByText(/Models could not be moved/)).toBeNull()
	})
})

describe("with modelSettings present", () => {
	beforeEach(() => {
		mocks.state = { ...mocks.state, modelSettings: modelSettingsFixture() }
	})

	it("is the new shell", () => {
		render(<SettingsView onDone={() => {}} />)
		expect(tabs()).toEqual(["models", "agent", "subagents", "tools", "layout", "data", "about"])
		expect(screen.getByLabelText("Search settings")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /^Changed/ })).toBeInTheDocument()
	})

	it("drops the internal-tester Debug exception", () => {
		mocks.internal.mockReturnValue(true)
		mocks.auth = { activeOrganization: null, clineUser: { email: "tester@example.com" } }
		render(<SettingsView onDone={() => {}} />)
		expect(tabs()).not.toContain("debug")
	})
})
