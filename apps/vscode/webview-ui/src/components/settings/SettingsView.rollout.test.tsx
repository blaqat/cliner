import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import SettingsView from "./SettingsView"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"

// The old tabs read this once, at import.
vi.hoisted(() => {
	process.env.IS_DEV = ""
})

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	auth: { activeOrganization: null, clineUser: null } as Record<string, unknown>,
	internal: vi.fn(() => false),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => mocks.auth }))
vi.mock("@/components/navigation/NavigationHistoryContext", () => ({ useNavigationHistory: () => undefined }))
vi.mock("@/components/common/ViewHeader", () => ({ default: () => <div>Settings</div> }))
vi.mock("@/services/grpc-client", () => ({ StateServiceClient: {}, ModelsServiceClient: {} }))
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
