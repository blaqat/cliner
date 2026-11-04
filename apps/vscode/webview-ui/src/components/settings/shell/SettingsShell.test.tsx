import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
import { createSettingsNavigationRequest, type SettingsNavigationTarget, settingsRowElementId } from "../settingsTargets"
import { SettingsShell } from "./SettingsShell"
import { SETTINGS_ROWS } from "./settingsRows"

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	state: {} as Record<string, unknown>,
	auth: { activeOrganization: null as { name: string; roles: string[] } | null },
	report: vi.fn(),
	getModelSettings: vi.fn(),
	setSubagentPolicy: vi.fn(),
	migration: vi.fn(),
	retry: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => mocks.auth }))
vi.mock("@/components/navigation/NavigationHistoryContext", () => ({
	useNavigationHistory: () => ({ reportSettingsSection: mocks.report }),
}))
vi.mock("@/components/common/ViewHeader", () => ({ default: () => <div>Settings</div> }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: mocks.update }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		getModelSettings: mocks.getModelSettings,
		getModelSettingsMigrationStatus: mocks.migration,
		retryModelSettingsMigration: mocks.retry,
		setSubagentPolicy: mocks.setSubagentPolicy,
	},
	StateServiceClient: { updateTerminalConnectionTimeout: vi.fn(), resetState: vi.fn() },
}))
vi.mock("../sections/DebugSection", () => ({ default: () => <div>debug panel</div> }))
vi.mock("../sections/RemoteConfigSection", () => ({ RemoteConfigSection: () => <div>remote config panel</div> }))
vi.mock("../environment/TerminalEnvironmentEditor", () => ({ default: () => <div>env editor</div> }))
vi.mock("@/components/worktrees/WorktreeSettings", () => ({ WorktreeSettings: () => <div>worktree settings</div> }))

const policy = { enabled: true, maxConcurrent: 3, access: { write: true, commands: true, web: true, mcp: true } }

const baseState = () => ({
	modelSettings: {
		...modelSettingsFixture(),
		settings: {
			...modelSettingsFixture().settings,
			roles: { ...modelSettingsFixture().settings.roles, subagents: { kind: "thread", level: "inherit" } },
			revision: 4,
			subagents: { ...policy, blocking: "parent-decides", allowed: [] },
		},
		managed: [] as string[],
	},
	autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
	browserSettings: DEFAULT_BROWSER_SETTINGS,
	worktreesEnabled: { featureFlag: true, user: false },
	remoteConfigSettings: {},
	telemetrySetting: "unset",
	platform: "darwin",
	availableTerminalProfiles: [{ id: "default", name: "Default" }],
	navigateToMcp: vi.fn(),
	version: "1.0.0",
	environment: "production",
})

const setNarrow = (narrow: boolean) => {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: narrow,
		media: query,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
	}))
}

const renderShell = (target?: SettingsNavigationTarget) =>
	render(<SettingsShell navigationRequest={target ? createSettingsNavigationRequest(target) : undefined} onDone={() => {}} />)

const flushFrame = () =>
	act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve))
	})

const visiblePage = () => screen.getAllByTestId(/^settings-page-/).find((page) => !page.hidden)?.dataset.testid
const search = (query: string) => fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: query } })
const row = (id: string) => document.getElementById(settingsRowElementId(id))
const changedChip = () => screen.getByRole("button", { name: /^Changed/ })

beforeEach(() => {
	vi.unstubAllEnvs()
	vi.stubEnv("IS_DEV", "")
	setNarrow(false)
	Element.prototype.scrollIntoView = vi.fn()
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	mocks.migration.mockReset().mockResolvedValue({ json: JSON.stringify({ status: "complete", retryable: false }) })
	mocks.retry.mockReset()
	mocks.update.mockClear()
	mocks.report.mockClear()
	mocks.setSubagentPolicy.mockClear().mockResolvedValue({ json: "{}" })
	mocks.getModelSettings.mockClear().mockResolvedValue({
		json: JSON.stringify({ settings: { revision: 9, subagents: policy } }),
	})
	mocks.state = baseState()
	mocks.auth = { activeOrganization: null }
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe("pages and nav", () => {
	it("shows the seven pages in order", () => {
		renderShell()
		expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([
			"Models",
			"Agent",
			"Subagents",
			"Tools",
			"Layout",
			"Data & privacy",
			"About",
		])
		expect(visiblePage()).toBe("settings-page-models")
	})

	it("reports the open page to Back history", () => {
		renderShell()
		fireEvent.click(screen.getByTestId("tab-tools"))
		expect(visiblePage()).toBe("settings-page-tools")
		expect(mocks.report).toHaveBeenLastCalledWith("tools")
	})

	it("shows names beside the icons in a wide panel", () => {
		renderShell()
		expect(within(screen.getByTestId("tab-agent")).getByText("Agent")).toBeInTheDocument()
	})

	it("goes icons-only in a narrow panel, with the name on hover", async () => {
		setNarrow(true)
		renderShell()
		const tab = screen.getByTestId("tab-agent")
		expect(within(tab).queryByText("Agent")).toBeNull()
		expect(tab).toHaveAccessibleName("Agent")
		fireEvent.focus(tab)
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Agent")
	})

	it("switches pages from every icon-only tab", () => {
		setNarrow(true)
		renderShell()
		for (const page of ["agent", "subagents", "tools", "layout", "data", "about", "models"]) {
			fireEvent.click(screen.getByTestId(`tab-${page}`))
			expect(visiblePage()).toBe(`settings-page-${page}`)
			expect(screen.getByTestId(`tab-${page}`)).toHaveAttribute("aria-selected", "true")
		}
	})

	it("keeps every nav item reachable by keyboard while a list is showing", () => {
		renderShell()
		search("reuse")
		for (const tab of screen.getAllByRole("tab")) {
			expect(tab).toHaveAttribute("tabindex", "0")
		}
	})
})

describe("search", () => {
	it("finds rows on other pages and counts them in the nav", () => {
		renderShell()
		search("reuse")
		expect(screen.getByTestId("settings-result-tools.terminal.reuse")).toBeInTheDocument()
		expect(within(screen.getByTestId("tab-tools")).getByText("1")).toBeInTheDocument()
	})

	it("finds a row by an alias", () => {
		renderShell()
		search("telemetry")
		expect(screen.getByTestId("settings-result-data.reporting")).toBeInTheDocument()
	})

	it("opens the target page and the closed Advanced fold, then highlights and focuses the row", async () => {
		renderShell()
		fireEvent.click(screen.getByTestId("tab-tools"))
		expect(row("tools.terminal.reuse")).toBeNull()
		fireEvent.click(screen.getByTestId("tab-models"))

		search("reuse")
		fireEvent.click(
			within(screen.getByTestId("settings-result-tools.terminal.reuse")).getByRole("button", { name: "Reuse terminals" }),
		)

		expect(visiblePage()).toBe("settings-page-tools")
		expect(screen.getByLabelText("Search settings")).toHaveValue("")
		await flushFrame()
		const target = row("tools.terminal.reuse")
		expect(target).toHaveClass("settings-target-highlight")
		expect(document.activeElement).toBe(within(target as HTMLElement).getByRole("switch"))
	})

	it("Enter opens the first hit", async () => {
		renderShell()
		search("reporting")
		fireEvent.keyDown(screen.getByLabelText("Search settings"), { key: "Enter" })
		expect(visiblePage()).toBe("settings-page-data")
		await flushFrame()
		expect(row("data.reporting.otel")).toHaveClass("settings-target-highlight")
	})

	it("says when nothing matches and offers to clear", () => {
		renderShell()
		search("zzzz")
		expect(screen.getByText("No settings match “zzzz”.")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
		expect(screen.getByLabelText("Search settings")).toHaveValue("")
		expect(visiblePage()).toBe("settings-page-models")
		expect(screen.queryByText(/No settings match/)).toBeNull()
	})

	it("Escape clears the search", () => {
		renderShell()
		search("reuse")
		fireEvent.keyDown(screen.getByLabelText("Search settings"), { key: "Escape" })
		expect(screen.getByLabelText("Search settings")).toHaveValue("")
	})

	it("picking a page leaves the list", () => {
		renderShell()
		search("reuse")
		fireEvent.click(screen.getByTestId("tab-layout"))
		expect(visiblePage()).toBe("settings-page-layout")
		expect(screen.getByLabelText("Search settings")).toHaveValue("")
	})

	it("never finds a row behind a gate", () => {
		renderShell()
		search("remote config")
		expect(screen.queryByTestId("settings-result-about.remote-config")).toBeNull()
		search("debug")
		expect(screen.queryByTestId("settings-result-debug.tools")).toBeNull()
	})
})

describe("unsaved edits", () => {
	it("a page stays mounted through search, Changed and other pages", async () => {
		const Draft = () => {
			const [text, setText] = useState("")
			return <input aria-label="unsaved" onChange={(event) => setText(event.target.value)} value={text} />
		}
		const { SETTINGS_PAGE_VIEWS } = await import("./settingsPages")
		const original = SETTINGS_PAGE_VIEWS.models.Component
		SETTINGS_PAGE_VIEWS.models.Component = Draft
		try {
			renderShell()
			fireEvent.change(screen.getByLabelText("unsaved"), { target: { value: "half typed" } })
			search("reuse")
			search("")
			fireEvent.click(changedChip())
			fireEvent.click(changedChip())
			fireEvent.click(screen.getByTestId("tab-tools"))
			fireEvent.click(screen.getByTestId("tab-models"))
			expect(screen.getByLabelText("unsaved")).toHaveValue("half typed")
		} finally {
			SETTINGS_PAGE_VIEWS.models.Component = original
		}
	})
})

describe("Changed and Reset", () => {
	beforeEach(() => {
		mocks.state = { ...baseState(), enableCheckpointsSetting: false, threadToastSeconds: 9, shellIntegrationTimeout: 4000 }
	})

	it("counts what differs from the default", () => {
		renderShell()
		expect(changedChip()).toHaveTextContent("Changed 2")
	})

	it("lists only changed rows, with both values", () => {
		renderShell()
		fireEvent.click(changedChip())
		expect(changedChip()).toHaveAttribute("aria-pressed", "true")
		const result = screen.getByTestId("settings-result-agent.checkpoints")
		expect(result).toHaveTextContent("Off · default On")
		expect(screen.getByTestId("settings-result-layout.toasts.seconds")).toHaveTextContent("Advanced")
		expect(screen.queryByTestId("settings-result-agent.language")).toBeNull()
	})

	it("says so when nothing is changed and offers the way back", () => {
		mocks.state = baseState()
		renderShell()
		expect(changedChip()).toHaveTextContent("Changed 0")
		fireEvent.click(changedChip())
		expect(screen.getByText("Nothing here differs from the default.")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show everything" }))
		expect(visiblePage()).toBe("settings-page-models")
	})

	it("Reset in the list writes the default", () => {
		renderShell()
		fireEvent.click(changedChip())
		fireEvent.click(screen.getByRole("button", { name: "Reset Checkpoints" }))
		expect(mocks.update).toHaveBeenCalledWith("enableCheckpointsSetting", true)
	})

	it("a changed row shows the tag and Reset on its page", () => {
		renderShell("agent")
		const target = row("agent.checkpoints") as HTMLElement
		expect(within(target).getByText("Changed")).toBeInTheDocument()
		fireEvent.click(within(target).getByRole("button", { name: "Reset Checkpoints" }))
		expect(mocks.update).toHaveBeenCalledWith("enableCheckpointsSetting", true)
		expect(within(row("agent.language") as HTMLElement).queryByText("Changed")).toBeNull()
	})

	it("a closed Advanced fold says how many changed values it hides", () => {
		renderShell("layout")
		const fold = screen.getByRole("button", { name: /^Advanced/ })
		expect(fold).toHaveAttribute("aria-expanded", "false")
		expect(fold).toHaveTextContent("1 changed")
		fireEvent.click(fold)
		expect(fold).toHaveAttribute("aria-expanded", "true")
		expect(within(row("layout.toasts.seconds") as HTMLElement).getByText("Changed")).toBeInTheDocument()
	})

	it("resets a subagent row through the policy store, against the latest revision", async () => {
		mocks.state = {
			...baseState(),
			modelSettings: {
				...modelSettingsFixture(),
				settings: { ...modelSettingsFixture().settings, revision: 4, subagents: { ...policy, enabled: false } },
				managed: [],
			},
		}
		renderShell("subagents")
		fireEvent.click(within(row("subagents.enabled") as HTMLElement).getByRole("button", { name: "Reset Subagents" }))
		await waitFor(() => expect(mocks.setSubagentPolicy).toHaveBeenCalled())
		const body = JSON.parse(mocks.setSubagentPolicy.mock.calls[0][0].json)
		expect(body.expectedRevision).toBe(9)
		expect(body.subagents.enabled).toBe(true)
		expect(mocks.update).not.toHaveBeenCalled()
	})
})

describe("dependent rows", () => {
	it("a row a parent turned off says why", () => {
		mocks.state = { ...baseState(), threadToastsEnabled: false }
		renderShell("layout.toasts.seconds")
		const target = row("layout.toasts.seconds") as HTMLElement
		expect(target).toHaveTextContent("Only with Toasts on.")
		expect(within(target).getByRole("textbox")).toBeDisabled()
	})

	it("says what's wrong with a number it can't use, and keeps it until fixed", () => {
		renderShell("layout.toasts.seconds")
		const input = within(row("layout.toasts.seconds") as HTMLElement).getByRole("textbox")
		fireEvent.change(input, { target: { value: "0" } })
		fireEvent.blur(input)
		expect(screen.getByRole("alert")).toHaveTextContent("1 or more, whole seconds")
		expect(mocks.update).not.toHaveBeenCalled()
		fireEvent.change(input, { target: { value: "8" } })
		fireEvent.blur(input)
		expect(mocks.update).toHaveBeenCalledWith("threadToastSeconds", 8)
	})
})

describe("managed rows", () => {
	beforeEach(() => {
		mocks.state = {
			...baseState(),
			telemetrySetting: "disabled",
			remoteConfigSettings: { telemetrySetting: "disabled" },
		}
		mocks.auth = { activeOrganization: { name: "Acme Corp", roles: ["member"] } }
	})

	it("shows the lock and Managed chip, names the org and locks the control", () => {
		renderShell("data")
		const target = row("data.reporting") as HTMLElement
		expect(within(target).getByText("Managed")).toBeInTheDocument()
		expect(target).toHaveTextContent("Acme Corp manages this. Ask your admin to change it.")
		expect(within(target).getByRole("switch")).toBeDisabled()
	})

	it("Reset is off with an explanation and never clears the org value", () => {
		renderShell("data")
		const reset = within(row("data.reporting") as HTMLElement).getByRole("button", { name: "Reset" })
		expect(reset).toBeDisabled()
		expect(reset.getAttribute("title")).toContain("Acme Corp manages this")
		fireEvent.click(reset)
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it("a managed value isn't a change of yours", () => {
		renderShell()
		expect(changedChip()).toHaveTextContent("Changed 0")
	})

	it("a Managed chip with a count lists what's managed", () => {
		renderShell()
		fireEvent.click(screen.getByRole("button", { name: /^Managed/ }))
		expect(screen.getByRole("button", { name: /^Managed/ })).toHaveTextContent("Managed 1")
		expect(screen.getByTestId("settings-result-data.reporting")).toBeInTheDocument()
	})

	it("has no Managed chip when nothing is managed", () => {
		mocks.state = baseState()
		renderShell()
		expect(screen.queryByRole("button", { name: /^Managed/ })).toBeNull()
	})

	it("also honors the host's managed list", () => {
		mocks.state = {
			...baseState(),
			modelSettings: {
				...modelSettingsFixture(),
				settings: { ...modelSettingsFixture().settings, revision: 1, subagents: policy },
				managed: ["subagentsMaxConcurrent"],
			},
		}
		renderShell("subagents")
		const target = row("subagents.cap") as HTMLElement
		expect(within(target).getByText("Managed")).toBeInTheDocument()
		expect(within(target).getByRole("textbox")).toBeDisabled()
	})
})

describe("deep links", () => {
	it.each<[SettingsNavigationTarget, string]>([
		["api-config", "models"],
		["profiles", "models"],
		["features", "agent"],
		["mcp-advanced", "tools"],
		["checkpoints", "agent"],
		["worktrees", "tools"],
		["terminal", "tools"],
		["general", "agent"],
		["reporting", "data"],
		["enter-sends-as", "layout"],
		["subagents", "subagents"],
		["about", "about"],
	])("%s opens %s", (target, page) => {
		renderShell(target)
		expect(visiblePage()).toBe(`settings-page-${page}`)
	})

	it("profiles opens Models > Background text > Generate, fold and all", async () => {
		renderShell("profiles")
		await flushFrame()
		expect(row("models.background.generate")).toHaveClass("settings-target-highlight")
	})

	it("MCP links open Tools > MCP Advanced", async () => {
		renderShell("mcp-advanced")
		await flushFrame()
		expect(row("tools.mcp.display")).toHaveClass("settings-target-highlight")
	})

	it("checkpoints focuses the switch", async () => {
		renderShell("checkpoints")
		await flushFrame()
		expect(document.activeElement).toBe(within(row("agent.checkpoints") as HTMLElement).getByRole("switch"))
	})

	it("a new request while Settings is open moves there", async () => {
		const view = renderShell("agent")
		view.rerender(<SettingsShell navigationRequest={createSettingsNavigationRequest("terminal")} onDone={() => {}} />)
		expect(visiblePage()).toBe("settings-page-tools")
		await flushFrame()
		expect(row("tools.terminal")).toHaveClass("settings-target-highlight")
	})

	it("answers the host's scrollToSettings message", () => {
		renderShell()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "grpc_response", grpc_response: { message: { key: "scrollToSettings", value: "worktrees" } } },
				}),
			)
		})
		expect(visiblePage()).toBe("settings-page-tools")
	})

	it("a model fix link opens Models", () => {
		renderShell("model:row-1:levels")
		expect(visiblePage()).toBe("settings-page-models")
	})

	it("a deep link leaves an open search", () => {
		const view = renderShell()
		search("reuse")
		view.rerender(<SettingsShell navigationRequest={createSettingsNavigationRequest("checkpoints")} onDone={() => {}} />)
		expect(screen.getByLabelText("Search settings")).toHaveValue("")
		expect(visiblePage()).toBe("settings-page-agent")
	})
})

describe("the registry and the pages", () => {
	it("every row exists where its deep link goes", () => {
		vi.stubEnv("IS_DEV", "true")
		mocks.auth = { activeOrganization: { name: "Acme", roles: ["admin"] } }
		for (const entry of SETTINGS_ROWS) {
			const view = renderShell(entry.id as SettingsNavigationTarget)
			expect(visiblePage(), entry.id).toBe(`settings-page-${entry.page}`)
			expect(row(entry.id), entry.id).not.toBeNull()
			view.unmount()
		}
	})
})

describe("dev and admin gates", () => {
	it("Debug is hidden outside dev builds, and its deep link lands on Models", () => {
		renderShell("debug")
		expect(screen.queryByTestId("tab-debug")).toBeNull()
		expect(screen.queryByText("debug panel")).toBeNull()
		expect(visiblePage()).toBe("settings-page-models")
	})

	it('a build that sets IS_DEV to "false" has no Debug page', () => {
		vi.stubEnv("IS_DEV", "false")
		renderShell()
		expect(screen.queryByTestId("tab-debug")).toBeNull()
	})

	it("no internal-tester exception: an internal address gets no Debug page", () => {
		mocks.auth = { activeOrganization: null, clineUser: { email: "someone@cline.bot" } } as never
		renderShell()
		expect(screen.queryByTestId("tab-debug")).toBeNull()
	})

	it("Debug is the eighth page in dev builds", () => {
		vi.stubEnv("IS_DEV", "true")
		renderShell("debug")
		expect(screen.getAllByRole("tab")).toHaveLength(8)
		expect(screen.getByText("debug panel")).toBeInTheDocument()
	})

	it("Remote Config is in About's Advanced for admins", async () => {
		mocks.auth = { activeOrganization: { name: "Acme", roles: ["admin"] } }
		renderShell("remote-config")
		expect(visiblePage()).toBe("settings-page-about")
		expect(screen.getByText("remote config panel")).toBeInTheDocument()
		await flushFrame()
		expect(row("about.remote-config")).toHaveClass("settings-target-highlight")
	})

	it("Remote Config is not a page of its own", () => {
		mocks.auth = { activeOrganization: { name: "Acme", roles: ["owner"] } }
		renderShell()
		expect(screen.queryByTestId("tab-remote-config")).toBeNull()
	})

	it.each([
		["a member", { name: "Acme", roles: ["member"] }],
		["no organization", null],
	])("Remote Config stays closed to %s, and the link lands on About", (_name, activeOrganization) => {
		mocks.auth = { activeOrganization }
		renderShell("remote-config")
		expect(visiblePage()).toBe("settings-page-about")
		expect(screen.queryByText("remote config panel")).toBeNull()
		expect(screen.queryByRole("button", { name: /^Advanced/ })).toBeNull()
	})
})

describe("Phase 7 pages", () => {
	it("keeps compaction controls inline and omits removed settings", () => {
		renderShell("agent")
		expect(screen.queryByText("Compaction strategy")).toBeNull()
		fireEvent.click(within(row("agent.compact")!).getByRole("button", { name: /Advanced/ }))
		expect(screen.getByText("Compaction strategy")).toBeVisible()
		expect(screen.queryByText("Compact at")).toBeNull()
		expect(screen.queryByText("Generate thread titles")).toBeNull()
		expect(screen.queryByText("Add review notes")).toBeNull()
	})
	it("renders the cap and all three blocking choices", () => {
		renderShell("subagents")
		expect(screen.getByRole("textbox", { name: "At most, per thread" })).toHaveValue("3")
		fireEvent.click(screen.getByRole("combobox", { name: "Can block the parent" }))
		expect(screen.getByRole("option", { name: "Never" })).toBeVisible()
		expect(screen.getByRole("option", { name: "Always wait" })).toBeVisible()
	})
	it("uses the existing dock for its selected card and reacts to a drag", () => {
		mocks.state = { ...baseState(), oneViewEnabled: true }
		const dockStorage = new Map<string, string>([["oneView.dock", "left"]])
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => dockStorage.get(key) ?? null,
			setItem: (key: string, value: string) => dockStorage.set(key, value),
		})
		renderShell("layout")
		expect(screen.getByRole("radio", { name: "Side Bar" })).toHaveAttribute("aria-checked", "true")
		act(() => {
			localStorage.setItem("oneView.dock", "top")
			window.dispatchEvent(new Event("cline:dock-changed"))
		})
		expect(screen.getByRole("radio", { name: "Tab bar" })).toHaveAttribute("aria-checked", "true")
		fireEvent.click(screen.getByRole("radio", { name: "Classic" }))
		expect(mocks.update).toHaveBeenCalledWith("oneViewEnabled", false)
	})
	it("keeps workspace environment editing inside Terminal Advanced", () => {
		renderShell("tools")
		fireEvent.click(within(row("tools.terminal")!).getByRole("button", { name: /Advanced/ }))
		expect(screen.getByText("env editor")).toBeVisible()
	})
	it("confirms clearing history inside the row and has no settings export", () => {
		renderShell("data")
		fireEvent.click(screen.getByRole("button", { name: "History", exact: true }))
		expect(within(row("data.history")!).getByRole("button", { name: "Confirm clear" })).toBeVisible()
		expect(screen.queryByRole("dialog")).toBeNull()
		expect(screen.queryByText("Export settings as a file")).toBeNull()
	})
})

describe("Phase 7 recovery", () => {
	it("preserves migration failure, reports a failed retry, then completes", async () => {
		mocks.migration.mockResolvedValue({ json: JSON.stringify({ status: "failed", retryable: true }) })
		mocks.retry
			.mockRejectedValueOnce(new Error("keychain unavailable"))
			.mockResolvedValueOnce({ json: JSON.stringify({ status: "complete", retryable: false }) })
		renderShell("about")
		fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("Your setup is untouched")
		fireEvent.click(screen.getByRole("button", { name: "Retry" }))
		await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull())
		expect(mocks.retry).toHaveBeenCalledTimes(2)
	})
	it("shows why the move failed, and what the finished move flagged", async () => {
		mocks.migration.mockResolvedValueOnce({
			json: JSON.stringify({ status: "failed", retryable: true, cause: "Could not write to the connection keychain" }),
		})
		const { unmount } = renderShell("about")
		expect(await screen.findByText("Could not write to the connection keychain")).toBeVisible()
		unmount()

		const state = baseState()
		const flagged = state.modelSettings.settings.models[0]
		flagged.upstreamId = "model-id-needed"
		mocks.state = state
		mocks.migration.mockResolvedValueOnce({
			json: JSON.stringify({
				status: "complete",
				retryable: false,
				issues: [{ kind: "normalized", field: "modelId", source: "Local", modelId: flagged.id }],
			}),
		})
		renderShell("about")
		expect(await screen.findByText(/Local: no model ID was saved/)).toBeVisible()
		expect(screen.getByRole("button", { name: "Add the model ID" })).toBeVisible()
	})
	it.each(["add", "edit", "remove"])("writes an allowed-list %s against the latest revision", async (action) => {
		const initial = action === "add" ? [] : [{ kind: "model", modelId: "sol", levels: ["medium"] }]
		const state = baseState()
		state.modelSettings.settings.subagents.allowed = initial as typeof state.modelSettings.settings.subagents.allowed
		mocks.state = state
		mocks.getModelSettings.mockResolvedValue({
			json: JSON.stringify({ ...state.modelSettings, settings: { ...state.modelSettings.settings, revision: 9 } }),
		})
		renderShell("subagents.allowed")
		if (action === "remove") fireEvent.click(screen.getByRole("button", { name: "Remove" }))
		else {
			fireEvent.click(
				screen.getByRole("button", {
					name: new RegExp(action === "add" ? "^Add allowed model:" : "^Edit allowed model:"),
				}),
			)
			fireEvent.click(within(await screen.findByTestId("model-list")).getByRole("option", { name: "GPT-5.4" }))
			fireEvent.keyDown(screen.getByTestId("model-list"), { key: "Enter" })
		}
		await waitFor(() => expect(mocks.setSubagentPolicy).toHaveBeenCalled())
		const body = JSON.parse(mocks.setSubagentPolicy.mock.calls[0][0].json)
		expect(body.expectedRevision).toBe(9)
		expect(body.subagents.allowed).toEqual(
			action === "remove" ? [] : [{ kind: "model", modelId: "g54", levels: [expect.any(String)] }],
		)
	})
})
