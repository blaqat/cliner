import { SETTINGS_LOCK_HELD_CAUSE } from "@shared/model-settings-migration-status"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
import SettingsView from "./SettingsView"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	auth: { activeOrganization: null, clineUser: null } as Record<string, unknown>,
	retry: vi.fn(),
	openLogs: vi.fn(),
	done: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => mocks.auth }))
vi.mock("@/components/navigation/NavigationHistoryContext", () => ({ useNavigationHistory: () => undefined }))
vi.mock("@/components/common/ViewHeader", () => ({
	default: ({ onDone }: { onDone: () => void }) => (
		<button onClick={onDone} type="button">
			Done
		</button>
	),
}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: {},
	ModelsServiceClient: { getModelSettings: async () => ({ json: "{}" }), retryModelSettingsMigration: mocks.retry },
	UiServiceClient: { openLogs: mocks.openLogs },
}))
vi.mock("./sections/DebugSection", () => ({ default: () => <div>debug panel</div> }))
vi.mock("./sections/RemoteConfigSection", () => ({ RemoteConfigSection: () => <div>remote config panel</div> }))
vi.mock("./environment/TerminalEnvironmentEditor", () => ({ default: () => null }))
vi.mock("@/components/worktrees/WorktreeSettings", () => ({ WorktreeSettings: () => null }))

const tabs = () => screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-value"))
const failed = { status: "failed", retryable: true, cause: "Could not write to the connection keychain" }

beforeEach(() => {
	vi.clearAllMocks()
	mocks.openLogs.mockResolvedValue({})
	mocks.auth = { activeOrganization: null, clineUser: null }
	mocks.state = { remoteConfigSettings: {}, availableTerminalProfiles: [], platform: "darwin" }
})

describe("when the move of model settings failed", () => {
	beforeEach(() => {
		mocks.state = { ...mocks.state, modelSettingsMigrationStatus: failed }
	})

	it("says what failed and that Cline is still running, and shows no pages", () => {
		render(<SettingsView onDone={mocks.done} />)
		expect(screen.getByText(/couldn't be moved/)).toBeInTheDocument()
		expect(screen.getByText(failed.cause)).toBeInTheDocument()
		expect(screen.getByText(/still running on your last selection/)).toBeInTheDocument()
		expect(screen.queryByRole("tab")).toBeNull()
		expect(screen.queryByLabelText("Search settings")).toBeNull()
	})

	it("says another window has settings when that's the cause, not that Cline is still running", () => {
		mocks.state = {
			...mocks.state,
			modelSettingsMigrationStatus: { ...failed, cause: SETTINGS_LOCK_HELD_CAUSE },
		}
		render(<SettingsView onDone={mocks.done} />)
		expect(screen.getByText(/Another window is using settings/)).toHaveTextContent(/Retry/)
		expect(screen.queryByText(/still running/)).toBeNull()
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
	})

	it("retries with the existing RPC", async () => {
		mocks.retry.mockResolvedValue({ json: JSON.stringify({ status: "complete", retryable: false }) })
		render(<SettingsView onDone={mocks.done} />)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Retry" }))
		})
		expect(mocks.retry).toHaveBeenCalledWith({ json: "{}" })
	})

	it("says so when the retry itself can't reach the host", async () => {
		mocks.retry.mockRejectedValue(new Error("no"))
		render(<SettingsView onDone={mocks.done} />)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Retry" }))
		})
		expect(screen.getByRole("alert")).toHaveTextContent(/couldn't finish/)
	})

	it("opens the logs, and says so if it can't", async () => {
		render(<SettingsView onDone={mocks.done} />)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Open logs" }))
		})
		expect(mocks.openLogs).toHaveBeenCalledOnce()
		mocks.openLogs.mockRejectedValue(new Error("no"))
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Open logs" }))
		})
		expect(screen.getByRole("alert")).toHaveTextContent(/Could not open logs/)
	})

	it("can always be left", () => {
		render(<SettingsView onDone={mocks.done} />)
		fireEvent.click(screen.getByRole("button", { name: "Done" }))
		expect(mocks.done).toHaveBeenCalledOnce()
	})

	it("becomes the pages the moment the store arrives", () => {
		const { rerender } = render(<SettingsView onDone={mocks.done} />)
		mocks.state = {
			...mocks.state,
			modelSettings: modelSettingsFixture(),
			modelSettingsMigrationStatus: { status: "complete", retryable: false },
		}
		rerender(<SettingsView onDone={mocks.done} />)
		expect(screen.getByLabelText("Search settings")).toBeInTheDocument()
		expect(screen.queryByText(/couldn't be moved/)).toBeNull()
	})
})

describe("while the move hasn't finished", () => {
	it.each([
		undefined,
		{ status: "pending", retryable: false },
	])("says so and keeps retry and logs in reach for %j", (status) => {
		mocks.state = { ...mocks.state, modelSettingsMigrationStatus: status }
		render(<SettingsView onDone={mocks.done} />)
		expect(screen.getByText(/Moving your model setup/)).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Open logs" })).toBeInTheDocument()
		expect(screen.queryByText(/couldn't be moved/)).toBeNull()
	})
})

describe("with modelSettings present", () => {
	beforeEach(() => {
		mocks.state = { ...mocks.state, modelSettings: modelSettingsFixture() }
	})

	it("is the seven pages", () => {
		render(<SettingsView onDone={mocks.done} />)
		expect(tabs()).toEqual(["models", "agent", "subagents", "tools", "layout", "data", "about"])
		expect(screen.getByLabelText("Search settings")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /^Changed/ })).toBeInTheDocument()
	})

	it("has no internal-tester Debug exception", () => {
		mocks.auth = { activeOrganization: null, clineUser: { email: "tester@cline.bot" } }
		render(<SettingsView onDone={mocks.done} />)
		expect(tabs()).not.toContain("debug")
	})
})
