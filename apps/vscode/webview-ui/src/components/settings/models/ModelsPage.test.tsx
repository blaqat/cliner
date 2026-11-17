import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { selectorDataFromModelSettings } from "@/components/models/modelSelectorRows"
import {
	createSettingsNavigationRequest,
	type SettingsNavigationTarget,
	settingsConnectionElementId,
	settingsModelElementId,
	settingsRowElementId,
	settingsTargetFromHost,
} from "../settingsTargets"
import { SettingsShell } from "../shell/SettingsShell"
import { createFakeHost, type FakeHost, type FakeHostOptions, gatewaySettings, levelsUpTo, modelRow } from "./modelsPage.fixture"
import { friendlyError } from "./modelsView"

const mocks = vi.hoisted(() => ({
	host: {} as Record<string, unknown>,
	state: {} as Record<string, unknown>,
	auth: { activeOrganization: null as { name: string; roles: string[] } | null },
	login: vi.fn(async () => ({ value: "" })),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => mocks.auth }))
vi.mock("@/components/navigation/NavigationHistoryContext", () => ({
	useNavigationHistory: () => ({ reportSettingsSection: vi.fn() }),
}))
vi.mock("@/components/common/ViewHeader", () => ({ default: () => <div>Settings</div> }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: new Proxy({}, { get: (_target, name: string) => mocks.host[name] }),
	StateServiceClient: {},
	AccountServiceClient: { accountLoginClicked: mocks.login, openAiCodexSignIn: mocks.login, accountLogoutClicked: mocks.login },
	OcaAccountServiceClient: { ocaAccountLoginClicked: mocks.login },
}))

let host: FakeHost

const setup = (options: FakeHostOptions = {}, target?: SettingsNavigationTarget, extraState: Record<string, unknown> = {}) => {
	host = createFakeHost(options)
	mocks.host = host.client
	mocks.state = {
		modelSettings: host.state(),
		remoteConfigSettings: {},
		navigateToHistory: vi.fn(),
		platform: "darwin",
		environment: "production",
		...extraState,
	}
	return render(
		<SettingsShell navigationRequest={target ? createSettingsNavigationRequest(target) : undefined} onDone={() => {}} />,
	)
}

const page = () => within(screen.getByTestId("settings-page-models"))
const change = (label: string | RegExp, value: string, root = page()) => {
	const input = root.getByLabelText(label)
	fireEvent.change(input, { target: { value } })
	fireEvent.blur(input)
	return input
}
const flush = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
const flushFrame = () =>
	act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve))
	})
const openModel = async (id: string) => {
	const row = within(screen.getByTestId(`model-row-${id}`))
	fireEvent.click(row.getAllByRole("button")[0])
	await flush()
	return within(screen.getByTestId(`model-form-${id}`))
}
const openMore = async (form: ReturnType<typeof within>) => {
	fireEvent.click(form.getByRole("button", { name: /^More/ }))
	await flush()
}
const savedRow = (id: string) => host.state().settings.models.find((row) => row.id === id)

const envAvailable = { sol: { available: true }, g54: { available: true }, mini: { available: true }, tuned: { available: true } }

beforeEach(() => {
	vi.unstubAllEnvs()
	vi.stubEnv("IS_DEV", "")
	mocks.auth = { activeOrganization: null }
	Element.prototype.scrollIntoView = vi.fn()
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
	}))
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("first visit", () => {
	it("opens on the form, says nothing can run, and writes nothing", async () => {
		setup()
		await flush()
		expect(page().getByText(/Nothing can run yet/)).toBeInTheDocument()
		expect(page().getByLabelText("Base URL")).toBeInTheDocument()
		expect(page().getAllByTestId("model-pick-button")[0]).toHaveTextContent("No models yet")
		expect(host.callsTo("saveConnection")).toHaveLength(0)
	})

	it("a URL the organization locks can't be typed, so it doesn't hold up a new connection", async () => {
		setup({ managed: ["openAiBaseUrl"] })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Save connection" }))
		await flush()
		expect(page().queryByText("Add a base URL first.")).toBeNull()
		expect(host.callsTo("saveConnection")[0].connection).toMatchObject({ baseUrl: null, name: "Managed connection" })
	})
})

describe("adding many models from one base URL", () => {
	const startDraft = async (options: FakeHostOptions = {}) => {
		setup(options)
		await flush()
		change("API key", "sk-live-1234")
		await flush()
		change("Base URL", "https://gw.example/v1")
		await flush()
		await flush()
	}

	it("saves the draft on URL blur with its earlier key, then adds models", async () => {
		await startDraft()
		const [saved] = host.callsTo("saveConnection")
		expect(saved.connection).toMatchObject({
			baseUrl: "https://gw.example/v1",
			name: "gw.example",
			kind: "openai-compatible",
		})
		expect(saved.secrets).toEqual([{ field: "apiKey", operation: "set", value: "sk-live-1234" }])
		expect(screen.getByTestId(`connection-form-${host.state().settings.connections[0].id}`)).toBeInTheDocument()
		expect(page().getByLabelText("API key")).toHaveValue("")
		expect(page().getByLabelText("API key")).toHaveAttribute("placeholder", "Saved")
		expect(host.secrets[`settings:v1:connection:${host.state().settings.connections[0].id}:apiKey`]).toBe("sk-live-1234")
		const add = within(screen.getByTestId("add-models"))
		await waitFor(() => expect(add.getByRole("checkbox", { name: /gpt-6-sol/ })).toBeInTheDocument())
		fireEvent.click(add.getByRole("checkbox", { name: /gpt-6-sol/ }))
		fireEvent.click(add.getByRole("checkbox", { name: /gpt-5\.4/ }))
		fireEvent.click(add.getByRole("button", { name: "Add 2 models" }))
		await flush()
		await flush()
		const models = host.callsTo("saveConfiguredModels")[0].models as { upstreamId: string; connectionId: string }[]
		expect(models.map((row) => row.upstreamId)).toEqual(["gpt-6-sol", "gpt-5.4"])
		expect(new Set(models.map((row) => row.connectionId)).size).toBe(1)
		expect(screen.queryByTestId("add-models")).toBeNull()
	})

	it("the first model added leaves Chat and Background text blank, and says why nothing can run", async () => {
		await startDraft()
		const add = within(screen.getByTestId("add-models"))
		await waitFor(() => expect(add.getByRole("checkbox", { name: /gpt-6-sol/ })).toBeInTheDocument())
		fireEvent.click(add.getByRole("checkbox", { name: /gpt-6-sol/ }))
		fireEvent.click(add.getByRole("button", { name: "Add model" }))
		await flush()
		await flush()
		expect(host.callsTo("setModelRoles")).toHaveLength(0)
		expect(host.state().settings.roles.chat).toBeNull()
		expect(host.state().settings.roles.background.pick).toBeNull()
		expect(page().getByText(/Threads need a Chat model/)).toBeInTheDocument()
		expect(page().getByText(/Background text needs a model/)).toBeInTheDocument()
		expect(page().getAllByRole("button", { name: "Pick one" })).toHaveLength(2)
	})

	it("hides non-chat models, even one the host marks instead of omitting", async () => {
		const settings = gatewaySettings()
		setup({
			settings,
			availability: envAvailable,
			discovery: {
				gateway: {
					status: "ok",
					models: [
						{ upstreamId: "gpt-9", name: "gpt-9", classification: "chat", source: "discovered" },
						{
							upstreamId: "text-embedding-3-large",
							name: "text-embedding-3-large",
							classification: "non-chat",
							source: "discovered",
						},
					],
				},
			},
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add models" }))
		await flush()
		const panel = within(screen.getByTestId("add-models"))
		await waitFor(() => expect(panel.getByRole("checkbox", { name: /gpt-9/ })).toBeInTheDocument())
		expect(panel.queryByText("text-embedding-3-large")).toBeNull()
	})

	it("a connection with no /models silently takes a pasted list of IDs", async () => {
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			discovery: { gateway: { status: "no-list", manualEntry: true, models: [] } },
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add models" }))
		await flush()
		const panel = within(screen.getByTestId("add-models"))
		expect(panel.queryByRole("status")).toBeNull()
		expect(panel.getByRole("button", { name: "Add model" })).toBeDisabled()
		fireEvent.change(panel.getByLabelText("Model IDs"), { target: { value: "model-a\nmodel-b, model-c model-a" } })
		fireEvent.click(panel.getByRole("button", { name: "Add 3 models" }))
		await flush()
		await flush()
		const models = host.callsTo("saveConfiguredModels")[0].models as { upstreamId: string; connectionId: string }[]
		expect(models.map((row) => row.upstreamId)).toEqual(["model-a", "model-b", "model-c"])
		expect(models.every((row) => row.connectionId === "gateway")).toBe(true)
	})

	it("an ID typed that isn't listed can still be added", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add models" }))
		await flush()
		const panel = within(screen.getByTestId("add-models"))
		await waitFor(() => expect(panel.getByRole("checkbox", { name: /qwen3-coder/ })).toBeInTheDocument())
		fireEvent.change(panel.getByLabelText("Model IDs"), { target: { value: "secret-model" } })
		fireEvent.keyDown(panel.getByLabelText("Model IDs"), { key: "Enter" })
		await flush()
		expect(panel.getByRole("checkbox", { name: /secret-model/ })).toBeInTheDocument()
		expect(panel.getByRole("button", { name: "Add model" })).toBeInTheDocument()
	})

	it.each(["auth", "network"] as const)("a %s listing failure is silent and still allows manual IDs", async (status) => {
		setup({ settings: gatewaySettings(), availability: envAvailable, discovery: { gateway: { status, models: [] } } })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add models" }))
		await flush()
		expect(screen.queryByText(/turned the key down/)).toBeNull()
		expect(within(screen.getByTestId("add-models")).getByLabelText("Model IDs")).toBeInTheDocument()
	})
})

describe("the list", () => {
	it("shows model names, known details and switches under their connection", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const sol = within(screen.getByTestId("model-row-sol"))
		expect(sol.getByText("GPT-6 Sol")).toBeInTheDocument()
		expect(sol.getByText(/Low–XHigh/)).toBeInTheDocument()
		expect(sol.getByText(/gpt-6-sol · Low–XHigh · 400K · \$5 \/ \$20/)).toBeInTheDocument()

		expect(within(screen.getByTestId("model-row-mini")).getByText(/Low–High/)).toBeInTheDocument()
	})

	it("an unknown context window uses the planning fallback without displaying or saving it", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const row = screen.getByTestId("model-row-tuned")
		expect(within(row).queryByText(/128K|unknown/i)).toBeNull()
		expect(host.state().planning.tuned).toEqual({ contextWindowKnown: false, planningContextWindow: 128000 })
		const form = await openModel("tuned")
		expect(form.getByLabelText("Context window")).toHaveValue("")
		expect(host.state().settings.models.find((model) => model.id === "tuned")?.overrides.contextWindow).toBeUndefined()
	})

	it("every model shows in the selector and there are no stars", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		expect(page().queryByRole("button", { name: /star/i })).toBeNull()
		fireEvent.click(page().getAllByTestId("model-pick-button")[0])
		const menu = await screen.findByTestId("model-menu")
		for (const name of ["GPT-6 Sol", "GPT-5.4", "GPT-5.6 Mini", "acme-tuned-coder"]) {
			expect(within(menu).getByRole("option", { name })).toBeInTheDocument()
		}
	})
})

describe("role rows", () => {
	it("Subagents can be Same as the thread; Background text can't", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const [, subagents, background] = page().getAllByTestId("model-pick-button")
		expect(subagents).toHaveTextContent("Same as the thread")
		fireEvent.click(background)
		const menu = await screen.findByTestId("model-menu")
		expect(within(menu).queryByRole("option", { name: "Same as the thread" })).toBeNull()
		fireEvent.keyDown(menu, { key: "Escape" })
		await flush()
		fireEvent.click(subagents)
		expect(
			within(await screen.findByTestId("model-menu")).getByRole("option", { name: "Same as the thread" }),
		).toBeInTheDocument()
	})

	it("picking a Chat model writes the role, and only that", async () => {
		const settings = gatewaySettings()
		settings.roles.chat = null
		setup({ settings, availability: envAvailable })
		await flush()
		const chat = page().getAllByTestId("model-pick-button")[0]
		expect(chat).toHaveTextContent("Pick a model")
		fireEvent.click(chat)
		const menu = await screen.findByTestId("model-menu")
		fireEvent.click(within(menu).getByRole("option", { name: "GPT-5.4" }))
		fireEvent.keyDown(within(menu).getByTestId("model-effort-lists"), { key: "Enter" })
		await flush()
		await flush()
		expect((host.callsTo("setModelRoles")[0].roles as { chat: { modelId: string } }).chat.modelId).toBe("g54")
		expect(host.state().settings.roles.background.pick?.modelId).toBe("mini")
	})

	it("a saved level the model doesn't offer won't start: says why and links to both fixes", async () => {
		const settings = gatewaySettings()
		// The host won't let this be written, but an older store or a later edit elsewhere can leave it.
		const state = createFakeHost({ settings, availability: envAvailable }).state()
		state.settings.roles.chat = { modelId: "mini", levelId: "xhigh" }
		setup({ settings, availability: envAvailable }, undefined, { modelSettings: state })
		await flush()
		const row = document.getElementById(settingsRowElementId("models.chat")) as HTMLElement
		expect(within(row).getByText(/GPT-5\.6 Mini doesn't offer XHigh, so this pick won't start/)).toBeInTheDocument()
		expect(within(row).getByRole("button", { name: "Pick a level" })).toBeInTheDocument()
		fireEvent.click(within(row).getByRole("button", { name: "Edit the model" }))
		await flush()
		expect(screen.getByTestId("model-form-mini")).toBeInTheDocument()
	})

	it("a pick on a connection that can't run says so and links to the connection", async () => {
		setup({
			settings: gatewaySettings(),
			availability: { ...envAvailable, sol: { available: false, reason: "Connection credentials are missing" } },
		})
		await flush()
		const row = document.getElementById(settingsRowElementId("models.chat")) as HTMLElement
		expect(page().getByText(/Company gateway: key missing, so Chat won't start/)).toBeInTheDocument()
		expect(page().getByRole("button", { name: "Fix it" })).toBeInTheDocument()
		expect(within(row).queryByText(/key missing/)).toBeNull()
	})

	it("a missing key says so once, naming every pick it stops", async () => {
		const settings = gatewaySettings()
		settings.roles.background.pick = { modelId: "sol", levelId: "default" }
		settings.roles.ask = { enabled: true, pick: { modelId: "sol", levelId: "default" } }
		setup({
			settings,
			availability: { ...envAvailable, sol: { available: false, reason: "Connection credentials are missing" } },
		})
		await flush()
		expect(page().getAllByText(/key missing/)).toHaveLength(1)
		expect(page().getAllByRole("button", { name: "Fix it" })).toHaveLength(1)
		expect(page().getByText(/so Chat, Different model for Ask and Background text won't start/)).toBeInTheDocument()
	})

	it("Advanced holds Ask, per-use overrides and a writable timeout", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: /Advanced/ }))
		await flush()
		expect(page().getByText("Different model for Ask")).toBeInTheDocument()
		expect(page().getByText("Commit messages")).toBeInTheDocument()
		expect(page().getByText("Walkthrough Generate")).toBeInTheDocument()
		expect(page().getByText("Thread titles")).toBeInTheDocument()
		expect(page().getByLabelText("Request timeout")).toBeEnabled()
		expect(page().getByText(/Only with/)).toBeInTheDocument()
	})

	it("the request timeout saves in seconds, refuses nonsense, and clears", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: /Advanced/ }))
		await flush()
		change("Request timeout", "abc")
		await flush()
		expect(page().getByText("A number of seconds, above 0.")).toBeInTheDocument()
		expect(host.callsTo("setModelRoles")).toEqual([])
		change("Request timeout", "45")
		await flush()
		await flush()
		expect(host.state().settings.requestTimeoutMs).toBe(45000)
		expect(host.state().settings.roles).toEqual(gatewaySettings().roles)
	})

	it("emptying a saved request timeout clears it", async () => {
		const settings = gatewaySettings()
		settings.requestTimeoutMs = 45000
		setup({ settings, availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: /Advanced/ }))
		await flush()
		expect(page().getByLabelText("Request timeout")).toHaveValue("45")
		change("Request timeout", "")
		await flush()
		await flush()
		expect(host.state().settings.requestTimeoutMs).toBeNull()
	})
})

describe("the model form", () => {
	it("two quick edits on one model both land", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("tuned")
		change("Max output tokens", "9000", form)
		change("Context window", "200000", form)
		await flush()
		await flush()
		expect(savedRow("tuned")?.overrides).toMatchObject({ maxOutputTokens: 9000, contextWindow: 200000, tools: "yes" })
	})

	it("keeps model fields up front and additional controls under More", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		// Up front: what you set a model up with.
		for (const label of ["Model ID", "Display name", "Context window", "Max output tokens", "Input $/1M", "Output $/1M"]) {
			expect(form.getByLabelText(label)).toBeInTheDocument()
		}
		expect(form.getByRole("radiogroup", { name: "Reasoning" })).toBeInTheDocument()
		expect(screen.getByTestId("request-preview")).toBeInTheDocument()
		expect(form.getByRole("button", { name: "Remove" })).toBeInTheDocument()
		// Everything else waits under More.
		expect(form.queryByLabelText("Temperature")).toBeNull()
		for (const group of ["Can see images", "Can use tools", "Verbosity"]) {
			expect(form.queryByRole("radiogroup", { name: group })).toBeNull()
		}
		expect(form.queryByRole("button", { name: "Add param" })).toBeNull()
		// How each level maps.
		const table = within(form.getByTestId("level-table"))
		expect(table.getByText("reasoning.effort")).toBeInTheDocument()
		// A long parameter name wraps inside its column at sidebar width instead of running out of the table.
		expect(table.getByTestId("level-table-sent-as")).toHaveClass("min-w-0", "[overflow-wrap:anywhere]")
		for (const level of ["Default", "Low", "Medium", "High", "XHigh"]) {
			expect(table.getByRole("switch", { name: `Offer ${level}` })).toBeInTheDocument()
		}
		expect(table.getByText("Nothing sent")).toBeInTheDocument()
		expect(table.getByLabelText("High is sent as")).toHaveValue("high")
		// More.
		await openMore(form)
		for (const group of ["Can see images", "Can use tools", "Verbosity"]) {
			expect(form.getByRole("radiogroup", { name: group })).toBeInTheDocument()
		}
		// Images and tools are a plain yes or no.
		for (const group of ["Can see images", "Can use tools"]) {
			const options = within(form.getByRole("radiogroup", { name: group })).getAllByRole("radio")
			expect(options.map((option) => option.textContent)).toEqual(["Yes", "No"])
		}
		expect(form.getByLabelText("Temperature")).toBeInTheDocument()
		expect(form.getByRole("button", { name: "Add param" })).toBeInTheDocument()
		for (const label of ["Max input tokens", "Thinking budget", "Cache read price", "Cache write price"]) {
			expect(form.getByLabelText(label)).toBeInTheDocument()
		}
		for (const group of ["Streaming", "Prompt cache", "Can read files", "API type"]) {
			expect(form.getByRole("radiogroup", { name: group })).toBeInTheDocument()
		}
	})

	it("edits write the whole row, keep explicit values, and clear to inherit", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("tuned")
		change("Max output tokens", "9000", form)
		await flush()
		expect(savedRow("tuned")?.overrides.maxOutputTokens).toBe(9000)
		expect(savedRow("tuned")?.overrides.tools).toBe("yes")
		change("Max output tokens", "abc", form)
		await flush()
		expect(form.getByText("Has to be a whole number above 0.")).toBeInTheDocument()
		expect(savedRow("tuned")?.overrides.maxOutputTokens).toBe(9000)
		change("Max output tokens", "", form)
		await flush()
		expect(savedRow("tuned")?.overrides).not.toHaveProperty("maxOutputTokens")
	})

	it("saying it can reason offers Low to High, and level edits copy the whole table", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("tuned")
		fireEvent.click(within(form.getByRole("radiogroup", { name: "Reasoning" })).getByRole("radio", { name: "Yes" }))
		await flush()
		await flush()
		expect(savedRow("tuned")?.overrides.reasoning).toBe("yes")
		expect(savedRow("tuned")?.overrides.levels?.map((level) => level.id)).toEqual(["default", "low", "medium", "high"])
		const table = within(screen.getByTestId("level-table"))
		change("Low is sent as", "minimal", table)
		await flush()
		const low = savedRow("tuned")?.overrides.levels?.find((level) => level.id === "low")
		expect(low?.request).toEqual({ kind: "effort", value: "minimal" })
	})

	it("won't leave a role on a level that's being turned off: says who and links there", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		fireEvent.click(within(form.getByTestId("level-table")).getByRole("switch", { name: "Offer Medium" }))
		await flush()
		expect(form.getByText(/Chat is on Medium\. Pick another level there first/)).toBeInTheDocument()
		expect(form.getByRole("button", { name: "Open Chat" })).toBeInTheDocument()
		expect(savedRow("sol")?.overrides.levels?.some((level) => level.id === "medium")).toBe(true)
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(0)
	})

	it("reserved extra body names are refused before they travel", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		await openMore(form)
		fireEvent.click(form.getByRole("button", { name: "Add param" }))
		await flush()
		const extra = within(form.getByTestId("extra-body"))
		change("Param name", "temperature", extra)
		await flush()
		change("Param value", "0.5", extra)
		await flush()
		expect(extra.getByText(/handled by its own control/)).toBeInTheDocument()
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(0)
		change("Param name", "top_p", extra)
		await flush()
		expect(savedRow("sol")?.overrides.extraBody).toEqual({ top_p: 0.5 })
	})

	it("the request preview calls the host and shows its request", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		fireEvent.click(form.getByRole("button", { name: "Request preview" }))
		await flush()
		await flush()
		const preview = within(form.getByTestId("request-preview"))
		expect(preview.getByText(/POST https:\/\/ai\.acme\.example\/v1\/responses/)).toHaveTextContent(/"effort": "xhigh"/)
		expect(host.callsTo("previewConfiguredModelRequest")[0].pick).toEqual({ modelId: "sol", levelId: "xhigh" })
	})

	it("a preview the host can't make exact says so instead of guessing", async () => {
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			preview: { exact: false, reason: "This provider does not support HTTP request capture" },
		})
		await flush()
		const form = await openModel("sol")
		fireEvent.click(form.getByRole("button", { name: "Request preview" }))
		await flush()
		await flush()
		expect(
			form.getByText(/Can't show this one exactly: This provider does not support HTTP request capture/),
		).toBeInTheDocument()
	})
})

describe("shared defaults", () => {
	it("models follow; a model's own value shows Changed + Reset; changing the default updates only those that follow", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		// g54 follows $2/$8; sol set its own $5/$20.
		expect(within(screen.getByTestId("model-row-g54")).getByText(/\$2 \/ \$8/)).toBeInTheDocument()
		expect(within(screen.getByTestId("model-row-sol")).getByText(/\$5 \/ \$20/)).toBeInTheDocument()
		const shared = within(screen.getByTestId("shared-defaults-gateway"))
		fireEvent.click(shared.getByRole("button", { name: /Shared defaults/ }))
		await flush()
		change("Shared Input", "3", shared)
		await flush()
		expect(within(screen.getByTestId("model-row-g54")).getByText(/\$3 \/ \$8/)).toBeInTheDocument()
		expect(within(screen.getByTestId("model-row-mini")).getByText(/\$3 \/ \$8/)).toBeInTheDocument()
		expect(within(screen.getByTestId("model-row-sol")).getByText(/\$5 \/ \$20/)).toBeInTheDocument()
		expect(host.callsTo("saveConnection")[0].connection).toEqual({ id: "gateway", defaults: { inputPrice: 3 } })
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(0)
	})

	it("Reset deletes the model's value, so it follows again", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		fireEvent.click(form.getByRole("button", { name: "Reset Input $/1M" }))
		await flush()
		await flush()
		expect(savedRow("sol")?.overrides).not.toHaveProperty("inputPrice")
		expect(savedRow("sol")?.overrides.outputPrice).toBe(20)
		expect(form.queryByRole("button", { name: "Reset Input $/1M" })).toBeNull()
		expect(form.getByLabelText("Input $/1M")).toHaveValue("")
		expect(form.getByLabelText("Input $/1M")).toHaveAttribute("placeholder", "2")
		expect(form.getByRole("button", { name: "Reset Output $/1M" })).toBeInTheDocument()
	})

	it("an inherited capability is marked as inherited", async () => {
		const settings = gatewaySettings()
		settings.connections[0].defaults = { ...settings.connections[0].defaults, streaming: "no" }
		settings.models[3].overrides = { tools: "yes" }
		setup({ settings, availability: envAvailable })
		await flush()
		const form = await openModel("tuned")
		await openMore(form)
		const yes = within(form.getByRole("radiogroup", { name: "Streaming" })).getByRole("radio", { name: "No" })
		expect(yes).toHaveAttribute("aria-checked", "true")
		expect(yes).toHaveAttribute("title", "From this connection's shared defaults")
	})
})

describe("duplicate", () => {
	it("makes a blank-ID copy in place, saves nothing until it has an ID, copies no secrets and assigns no roles", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const original = await openModel("sol")
		fireEvent.click(original.getByRole("button", { name: "Duplicate" }))
		await flush()
		await flush()
		expect(host.callsTo("duplicateConfiguredModel")[0]).toEqual({ modelId: "sol" })
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(0)
		const input = page()
			.getAllByLabelText("Model ID")
			.find((box) => (box as HTMLInputElement).value === "") as HTMLInputElement
		expect(input).toHaveFocus()
		const form = within(input.closest("[data-testid^=model-form-]") as HTMLElement)
		change("Context window", "1000", form)
		await flush()
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(0)
		fireEvent.change(input, { target: { value: "gpt-6-sol-b" } })
		fireEvent.blur(input)
		await flush()
		await flush()
		const saved = host.callsTo("saveConfiguredModels")[0].models as {
			upstreamId: string
			overrides: { contextWindow: number; systemRole: string }
		}[]
		expect(saved[0].upstreamId).toBe("gpt-6-sol-b")
		expect(saved[0].overrides.contextWindow).toBe(1000)
		expect(saved[0].overrides.systemRole).toBe("developer")
		expect(host.callsTo("setModelRoles")).toHaveLength(0)
		expect(host.state().settings.models).toHaveLength(5)
	})

	it("a copy with no ID can be dropped without touching the host", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const original = await openModel("sol")
		fireEvent.click(original.getByRole("button", { name: "Duplicate" }))
		await flush()
		await flush()
		const form = within(screen.getAllByTestId(/^model-form-/)[0])
		fireEvent.click(form.getByRole("button", { name: "Remove" }))
		await flush()
		expect(screen.queryByTestId(/^model-form-/)).toBeNull()
		expect(host.callsTo("deleteConfiguredModel")).toHaveLength(0)
	})
})

describe("secrets", () => {
	const keyedSettings = () => {
		const settings = gatewaySettings()
		settings.connections[0].auth = { kind: "keychain", secretRef: "settings:v1:connection:gateway:apiKey" }
		return settings
	}
	const secrets = { "settings:v1:connection:gateway:apiKey": "sk-super-secret" }

	it("a saved key is never shown or resent; typing replaces it, write-only", async () => {
		setup({ settings: keyedSettings(), secrets, availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		const input = page().getByLabelText("API key")
		expect(input).toHaveValue("")
		expect(input).toHaveAttribute("type", "password")
		expect(input).toHaveAttribute("placeholder", "Saved")
		expect(document.body.innerHTML).not.toContain("sk-super-secret")
	})

	it("editing other fields sends no secret mutation at all", async () => {
		setup({ settings: keyedSettings(), secrets, availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		change("Connection name", "Gateway")
		await flush()
		const [saved] = host.callsTo("saveConnection")
		expect(saved.connection).toEqual({ id: "gateway", name: "Gateway" })
		expect(saved.secrets).toEqual([])
		expect(host.wire()).not.toContain("sk-super-secret")
	})

	it("a missing key's Fix it lands on the key field", async () => {
		setup({
			settings: keyedSettings(),
			availability: { ...envAvailable, sol: { available: false, reason: "Connection credentials are missing" } },
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Fix it" }))
		await flushFrame()
		await flush()
		expect(document.activeElement).toBe(page().getByLabelText("API key"))
	})

	it("a key that moved over under its old field name shows as saved, and replaces and removes in place", async () => {
		const ref = "settings:v1:connection:gateway:openAiApiKey"
		const settings = gatewaySettings()
		settings.connections[0].auth = { kind: "keychain", secretRef: ref }
		setup({ settings, secrets: { [ref]: "sk-moved" } })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		expect(page().getByLabelText("API key")).toHaveAttribute("placeholder", "Saved")
		change("API key", "sk-new")
		await flush()
		expect(host.callsTo("saveConnection")[0].secrets).toEqual([{ field: "openAiApiKey", operation: "set", value: "sk-new" }])
		expect(host.secrets[ref]).toBe("sk-new")
		fireEvent.click(page().getByRole("button", { name: "Remove API key" }))
		await flush()
		expect(host.secrets[ref]).toBeUndefined()
		expect(host.state().settings.connections[0].auth).toEqual({ kind: "none" })
	})

	it("a new key goes one way, and the box empties", async () => {
		setup({ settings: keyedSettings(), secrets, availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		const input = change("API key", "sk-new-value")
		await flush()
		expect(host.callsTo("saveConnection")[0].secrets).toEqual([{ field: "apiKey", operation: "set", value: "sk-new-value" }])
		expect(host.secrets["settings:v1:connection:gateway:apiKey"]).toBe("sk-new-value")
		expect(input).toHaveValue("")
		expect(JSON.stringify(host.state())).not.toContain("sk-new-value")
	})

	it("a masked value is refused here, before the host", async () => {
		setup({ settings: keyedSettings(), secrets, availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		change("API key", "••••3f9a")
		await flush()
		expect(page().getByText("Type the whole value, not a masked one.")).toBeInTheDocument()
		expect(host.callsTo("saveConnection")).toHaveLength(0)
	})

	it("Remove deletes it by name, with no value", async () => {
		setup({ settings: keyedSettings(), secrets, availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Remove API key" }))
		await flush()
		expect(host.callsTo("saveConnection")[0].secrets).toEqual([{ field: "apiKey", operation: "delete" }])
		expect(host.secrets["settings:v1:connection:gateway:apiKey"]).toBeUndefined()
		// With no key left the connection says so, rather than pointing at an empty keychain entry.
		expect(host.state().settings.connections[0].auth).toEqual({ kind: "none" })
		expect(host.callsTo("saveConnection")).toHaveLength(1)
	})

	describe("on a provider", () => {
		const bedrock = () => {
			const settings = gatewaySettings()
			settings.models = []
			settings.roles.chat = null
			settings.roles.background.pick = null
			settings.connections = [
				{
					id: "aws",
					name: "Bedrock",
					kind: "provider",
					providerId: "bedrock",
					baseUrl: null,
					auth: { kind: "none" },
					headers: [],
					requestTimeoutMs: null,
					defaults: {},
					options: {
						awsAuthentication: "credentials",
						awsRegion: "us-east-1",
						awsBedrockEndpoint: "https://vpc.example",
					},
					secretRefs: {
						awsAccessKey: "settings:v1:connection:aws:awsAccessKey",
						awsSessionToken: "settings:v1:connection:aws:awsSessionToken",
					},
				},
			]
			return settings
		}
		const providerSecrets = {
			"settings:v1:connection:aws:awsAccessKey": "AKIA",
			"settings:v1:connection:aws:awsSessionToken": "token",
		}
		const open = async () => {
			setup({ settings: bedrock(), secrets: providerSecrets })
			await flush()
			fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
			await flush()
		}

		it("removes an optional secret and its reference in one save", async () => {
			await open()
			fireEvent.click(page().getByRole("button", { name: /^Remove .*session token/i }))
			await flush()
			const [saved] = host.callsTo("saveConnection")
			expect(saved.secrets).toEqual([{ field: "awsSessionToken", operation: "delete" }])
			expect(saved.connection).toMatchObject({ remove: { secretRefs: ["awsSessionToken"] } })
			expect(host.secrets["settings:v1:connection:aws:awsSessionToken"]).toBeUndefined()
			const connection = host.state().settings.connections[0]
			expect(connection.kind === "provider" && Object.keys(connection.secretRefs)).toEqual(["awsAccessKey"])
		})

		it("a secret the connection can't work without says so, and only offers replacing it", async () => {
			await open()
			expect(page().getAllByRole("button", { name: /^Remove .*(session token|access key|secret)/i })).toHaveLength(1)
			expect(page().getAllByText("Required. Type a new one to replace it.").length).toBeGreaterThan(0)
		})

		it("clearing an option removes it instead of saving an empty string", async () => {
			await open()
			change("VPC endpoint", "")
			await flush()
			await flush()
			const connection = host.state().settings.connections[0]
			expect(connection.kind === "provider" && connection.options).toEqual({
				awsAuthentication: "credentials",
				awsRegion: "us-east-1",
			})
			expect(host.wire()).not.toContain('awsBedrockEndpoint":""')
		})
	})

	it("a header is plain until locked; locking moves its value to the keychain and out of the settings", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		expect(page().getByLabelText("Header value")).toHaveValue("platform")
		fireEvent.click(page().getByRole("button", { name: "Lock X-Team" }))
		await flush()
		await flush()
		const [saved] = host.callsTo("saveConnection")
		expect((saved.connection as { headers: unknown[] }).headers).toEqual([
			{ id: "h1", name: "X-Team", storage: "secret", secretRef: "settings:v1:connection:gateway:header-h1" },
		])
		expect(saved.secrets).toEqual([{ field: "header-h1", operation: "set", value: "platform" }])
		expect(JSON.stringify(host.state())).not.toContain("platform")
		expect(page().getByLabelText("Header value")).toHaveValue("")
		expect(page().getByLabelText("Header value")).toHaveAttribute("type", "password")
	})

	it("a header the move locked can be unlocked, which keeps its value as text", async () => {
		const secretRef = "settings:v1:connection:gateway:header-0"
		const settings = gatewaySettings()
		settings.connections[0].headers = [{ id: "header-0", name: "X-Api-Key", storage: "secret", secretRef }]
		setup({ settings, availability: envAvailable, secrets: { [secretRef]: "abc" } })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Unlock X-Api-Key" }))
		await flush()
		await flush()
		expect(host.callsTo("saveConnection")[0].secrets).toEqual([{ field: "header-0", operation: "unlock" }])
		expect(page().getByLabelText("Header value")).toHaveValue("abc")
		expect(page().getByLabelText("Header value")).toHaveAttribute("type", "text")
	})

	it("Azure API version only shows for Azure URLs, and only under More", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		const form = within(screen.getByTestId("connection-form-gateway"))
		fireEvent.click(form.getByRole("button", { name: /^More/ }))
		await flush()
		expect(form.queryByLabelText("Azure API version")).toBeNull()
		change("Base URL", "https://my.openai.azure.com/openai", form)
		await flush()
		expect(form.getByLabelText("Azure API version")).toBeInTheDocument()
		change("Azure API version", "2025-01-01-preview", form)
		await flush()
		change("Base URL", "https://gateway.test/v1", form)
		await flush()
		// Still set, so it stays where it can be cleared.
		expect(form.getByLabelText("Azure API version")).toHaveValue("2025-01-01-preview")
		fireEvent.click(form.getByRole("button", { name: /^More/ }))
		await flush()
		expect(form.queryByLabelText("Azure API version")).toBeNull()
	})
})

describe("other providers", () => {
	const openChooser = async (options: FakeHostOptions = {}) => {
		setup({ settings: gatewaySettings(), availability: envAvailable, ...options })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add provider" }))
		await flush()
		await flush()
		return within(screen.getByTestId("provider-chooser"))
	}

	it("offers the whole catalog, small: past the old four, with a filter and N more", async () => {
		const chooser = await openChooser()
		// OpenAI-compatible is the main case, not listed as a provider.
		expect(chooser.queryByRole("button", { name: "OpenAI Compatible" })).toBeNull()
		for (const name of [
			"Cline",
			"Anthropic",
			"OpenAI",
			"OpenRouter",
			"Amazon Bedrock",
			"Vertex AI",
			"Gemini",
			"Ollama",
			"LM Studio",
			"LiteLLM",
		]) {
			expect(chooser.getByRole("button", { name })).toBeInTheDocument()
		}
		expect(chooser.queryByRole("button", { name: "Groq" })).toBeNull()
		fireEvent.click(chooser.getByRole("button", { name: "5 more" }))
		expect(chooser.getByRole("button", { name: "Groq" })).toBeInTheDocument()
		fireEvent.change(chooser.getByLabelText("Filter providers"), { target: { value: "zzz" } })
		expect(chooser.getByText(/No provider called “zzz”/)).toBeInTheDocument()
		expect(chooser.getByRole("button", { name: "add a connection" })).toBeInTheDocument()
	})

	it("only what your organization allows", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable }, undefined, {
			remoteConfigSettings: { remoteConfiguredProviders: ["anthropic"] },
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add provider" }))
		await flush()
		await flush()
		const chooser = within(screen.getByTestId("provider-chooser"))
		expect(chooser.getByRole("button", { name: "Anthropic" })).toBeInTheDocument()
		expect(chooser.queryByRole("button", { name: "Groq" })).toBeNull()
		expect(chooser.queryByRole("button", { name: "Amazon Bedrock" })).toBeNull()
	})

	it("a required field the organization locks isn't asked for", async () => {
		const chooser = await openChooser({ discovery: {}, managed: ["liteLlmBaseUrl"] })
		fireEvent.click(chooser.getByRole("button", { name: "LiteLLM" }))
		await flush()
		const setupForm = within(screen.getByTestId("provider-setup-litellm"))
		change("API key", "sk-lite", setupForm)
		await flush()
		fireEvent.click(setupForm.getByRole("button", { name: "Connect" }))
		await flush()
		expect(host.callsTo("saveConnection")[0].connection).toMatchObject({ kind: "provider", providerId: "litellm" })
	})

	it("connects with its own fields, then its models join the same list; roles stay put", async () => {
		const chooser = await openChooser({
			catalog: { anthropic: { "opus-4.5": { name: "Opus 4.5" }, "sonnet-4.5": { name: "Sonnet 4.5" } } },
			discovery: {},
		})
		fireEvent.click(chooser.getByRole("button", { name: "Anthropic" }))
		await flush()
		const setupForm = within(screen.getByTestId("provider-setup-anthropic"))
		fireEvent.click(setupForm.getByRole("button", { name: "Connect" }))
		await flush()
		expect(setupForm.getByText("Anthropic needs a key.")).toBeInTheDocument()
		change("API key", "sk-ant-1", setupForm)
		await flush()
		fireEvent.click(setupForm.getByRole("button", { name: "Connect" }))
		await flush()
		await flush()
		const saved = host.callsTo("saveConnection")[0]
		expect(saved.connection).toMatchObject({ kind: "provider", providerId: "anthropic", name: "Anthropic" })
		expect(saved.secrets).toEqual([{ field: "apiKey", operation: "set", value: "sk-ant-1" }])
		const panel = within(screen.getByTestId("add-models"))
		await waitFor(() => expect(panel.getByRole("checkbox", { name: /sonnet-4\.5/ })).toBeInTheDocument())
		fireEvent.click(panel.getByRole("checkbox", { name: /sonnet-4\.5/ }))
		fireEvent.click(panel.getByRole("button", { name: "Add model" }))
		await flush()
		await flush()
		await flush()
		const rows = host.state().settings.models.filter((row) => row.upstreamId === "sonnet-4.5")
		expect(rows).toHaveLength(1)
		expect(host.callsTo("setModelRoles")).toHaveLength(0)
		expect(screen.queryByTestId("provider-chooser")).toBeNull()
		expect(screen.getByText("Sonnet 4.5")).toBeInTheDocument()
	})

	it("a sign-in provider starts the existing sign-in and points at the SDK account, with no key", async () => {
		const chooser = await openChooser({ catalog: { cline: { "cline/one": { name: "One" } } } })
		fireEvent.click(chooser.getByRole("button", { name: "Cline" }))
		await flush()
		const setupForm = within(screen.getByTestId("provider-setup-cline"))
		expect(setupForm.queryByLabelText("API key")).toBeNull()
		mocks.login.mockClear()
		fireEvent.click(setupForm.getByRole("button", { name: "Sign in" }))
		await flush()
		await flush()
		expect(mocks.login).toHaveBeenCalledTimes(1)
		expect(host.callsTo("saveConnection")[0].connection).toMatchObject({
			providerId: "cline",
			auth: { kind: "sdk-account", providerId: "cline" },
		})
		expect(host.callsTo("saveConnection")[0].secrets).toEqual([])
	})

	it("Bedrock keeps every field: connection ones under Edit, model ones in the form; secrets are write-only", async () => {
		const settings = gatewaySettings()
		settings.connections.push({
			id: "bed",
			name: "Bedrock",
			kind: "provider",
			providerId: "bedrock",
			baseUrl: null,
			auth: { kind: "none" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			options: { awsAuthentication: "credentials", awsRegion: "us-east-1" },
			secretRefs: { awsAccessKey: "settings:v1:connection:bed:awsAccessKey" },
		})
		settings.models.push(modelRow("claude", "bed", "anthropic.opus", "Opus", { reasoning: "yes", levels: levelsUpTo(3) }))
		setup({
			settings,
			availability: { ...envAvailable, claude: { available: true } },
			secrets: { "settings:v1:connection:bed:awsAccessKey": "AKIAREAL" },
		})
		await flush()
		const card = within(screen.getByTestId("connection-bed"))
		fireEvent.click(card.getAllByRole("button")[0])
		await flush()
		const open = within(screen.getByTestId("connection-bed"))
		fireEvent.click(open.getByRole("button", { name: "Edit connection" }))
		await flush()
		expect(open.getByLabelText("Authentication")).toBeInTheDocument()
		expect(open.getByLabelText("Region")).toHaveValue("us-east-1")
		expect(open.getByLabelText("Access key")).toHaveValue("")
		expect(open.getByLabelText("Secret key")).toBeInTheDocument()
		expect(open.getByLabelText("Session token")).toBeInTheDocument()
		expect(open.getByLabelText("VPC endpoint")).toBeInTheDocument()
		expect(open.getByLabelText("Request timeout")).toBeInTheDocument()
		expect(open.queryByLabelText("AWS profile")).toBeNull()
		expect(document.body.innerHTML).not.toContain("AKIAREAL")
		change("Region", "eu-west-1", open)
		await flush()
		expect(host.callsTo("saveConnection")[0].connection).toEqual({ id: "bed", options: { awsRegion: "eu-west-1" } })
		const form = await openModel("claude")
		await openMore(form)
		for (const name of ["Cross-region inference", "Global inference", "Prompt caching", "Use a custom model"]) {
			expect(form.getByRole("switch", { name })).toBeInTheDocument()
		}
		fireEvent.click(form.getByRole("switch", { name: "Use a custom model" }))
		await flush()
		await flush()
		expect(savedRow("claude")?.providerOptions).toEqual({ actModeAwsBedrockCustomSelected: true })
		expect(form.getByLabelText("Custom model base")).toBeInTheDocument()
	})

	it("controls nobody reads are left out, and their saved values survive edits", async () => {
		const settings = gatewaySettings()
		settings.connections.push({
			id: "or",
			name: "OpenRouter",
			kind: "provider",
			providerId: "openrouter",
			baseUrl: null,
			auth: { kind: "none" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			options: { openRouterProviderSorting: "price" },
			secretRefs: {},
		})
		setup({ settings, availability: envAvailable })
		await flush()
		fireEvent.click(within(screen.getByTestId("connection-or")).getAllByRole("button")[0])
		await flush()
		const open = within(screen.getByTestId("connection-or"))
		fireEvent.click(open.getByRole("button", { name: "Edit connection" }))
		await flush()
		expect(open.queryByText(/sorting/i)).toBeNull()
		change("API key", "or-key", open)
		await flush()
		const stored = host.state().settings.connections.find((connection) => connection.id === "or") as {
			options: Record<string, unknown>
		}
		expect(stored.options.openRouterProviderSorting).toBe("price")
	})
})

describe("removing", () => {
	it("removes an in-use model with one confirmation and clears every reference in that save", async () => {
		const settings = gatewaySettings()
		const pick = { modelId: "sol", levelId: "medium" }
		settings.roles.chat = pick
		settings.roles.ask = { enabled: true, pick }
		settings.roles.subagents = { kind: "model", pick }
		settings.roles.background.pick = pick
		settings.roles.background.overrides = { titles: pick, commitMessages: pick, generate: pick }
		settings.subagents.allowed = [{ kind: "model", modelId: "sol", levels: ["medium"] }]
		setup({ settings, availability: envAvailable, threadDependencies: { sol: ["t1", "t2"] } })
		await flush()
		const form = await openModel("sol")
		fireEvent.click(form.getByRole("button", { name: "Remove" }))
		await flush()
		const flow = within(screen.getByTestId("remove-flow"))
		expect(flow.getByText(/Also clears it from Chat/)).toHaveTextContent(/Background text/)
		expect(flow.getByText("2 saved threads will switch to your default.")).toBeInTheDocument()
		expect(savedRow("sol")).toBeDefined()
		expect(host.callsTo("deleteConfiguredModel")).toHaveLength(0)
		fireEvent.click(flow.getByRole("button", { name: "Remove" }))
		await flush()
		expect(savedRow("sol")).toBeUndefined()
		expect(screen.queryByTestId("model-row-sol")).toBeNull()
		expect(host.state().settings.roles).toMatchObject({
			chat: null,
			ask: { enabled: false, pick: null },
			subagents: { kind: "thread", level: "inherit" },
			background: { pick: null, overrides: {} },
		})
		expect(host.state().settings.subagents.allowed).toEqual([])
		expect(host.callsTo("deleteConfiguredModel")).toHaveLength(1)
		expect(host.callsTo("setModelRoles")).toHaveLength(0)
		expect(host.callsTo("setSubagentPolicy")).toHaveLength(0)
		expect(screen.queryByTestId("remove-flow")).toBeNull()
	})

	it("says how many saved threads use a model, and deletes it anyway", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable, threadDependencies: { tuned: ["t1", "t2", "t3"] } })
		await flush()
		const form = await openModel("tuned")
		fireEvent.click(form.getByRole("button", { name: "Remove" }))
		await flush()
		await flush()
		const flow = within(screen.getByTestId("remove-flow"))
		expect(flow.getByText("3 saved threads will switch to your default.")).toBeInTheDocument()
		fireEvent.click(flow.getByRole("button", { name: "Remove" }))
		await flush()
		await flush()
		expect(host.state().settings.models.some((model) => model.id === "tuned")).toBe(false)
	})

	it("says nothing about threads when none use it", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("tuned")
		fireEvent.click(form.getByRole("button", { name: "Remove" }))
		await flush()
		await flush()
		expect(screen.getByTestId("remove-flow").textContent).not.toMatch(/saved thread/)
	})

	it("removes a model nothing depends on", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("tuned")
		fireEvent.click(form.getByRole("button", { name: "Remove" }))
		await flush()
		fireEvent.click(within(screen.getByTestId("remove-flow")).getByRole("button", { name: "Remove" }))
		await flush()
		await flush()
		expect(host.state().settings.models.some((model) => model.id === "tuned")).toBe(false)
		expect(screen.queryByTestId("model-row-tuned")).toBeNull()
	})

	it("removes an in-use connection and its models with one confirmation", async () => {
		const settings = gatewaySettings()
		settings.subagents.allowed = [{ kind: "model", modelId: "mini", levels: ["low"] }]
		setup({ settings, availability: envAvailable, threadDependencies: { sol: ["t1", "t2"], mini: ["t2", "t3"] } })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Remove connection" }))
		await flush()
		const flow = within(screen.getByTestId("remove-flow"))
		expect(flow.getByText("Remove Company gateway and its 4 models?")).toBeInTheDocument()
		expect(flow.getByText("Also clears it from Chat, Background text and the subagents' list.")).toBeInTheDocument()
		expect(flow.getByText("3 saved threads will switch to your default.")).toBeInTheDocument()
		expect(host.state().settings.models).toHaveLength(4)
		fireEvent.click(flow.getByRole("button", { name: "Remove" }))
		await flush()
		expect(host.state().settings.models).toEqual([])
		expect(host.state().settings.connections).toEqual([])
		expect(host.state().settings.roles.chat).toBeNull()
		expect(host.state().settings.roles.background.pick).toBeNull()
		expect(host.state().settings.subagents.allowed).toEqual([])
		expect(host.callsTo("deleteConnection")).toHaveLength(1)
		expect(host.callsTo("deleteConfiguredModel")).toHaveLength(0)
		expect(host.callsTo("setModelRoles")).toHaveLength(0)
		expect(screen.queryByTestId("connection-gateway")).toBeNull()
	})

	it("Cancel leaves everything", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Remove connection" }))
		await flush()
		fireEvent.click(within(screen.getByTestId("remove-flow")).getByRole("button", { name: "Cancel" }))
		await flush()
		expect(screen.queryByTestId("remove-flow")).toBeNull()
		expect(host.callsTo("deleteConnection")).toHaveLength(0)
	})
})

describe("fix links land on real controls", () => {
	it("model:<id>:levels opens the form and focuses a level control", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable }, "model:g54:levels")
		await flushFrame()
		await flushFrame()
		expect(screen.getByTestId("model-form-g54")).toBeInTheDocument()
		const control = document.getElementById(`${settingsModelElementId("g54", "levels")}-control`)
		expect(control).toHaveAttribute("role", "switch")
		expect(control).toHaveFocus()
	})

	it("levels on a model that doesn't reason yet focuses the Reasoning control", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable }, "model:tuned:levels")
		await flushFrame()
		await flushFrame()
		const control = document.getElementById(`${settingsModelElementId("tuned", "levels")}-control`)
		expect(control).toHaveAttribute("role", "radio")
		expect(control).toHaveFocus()
	})

	it("a field in More opens More", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable }, "model:sol:thinkingBudgetTokens")
		await flushFrame()
		await flushFrame()
		expect(document.getElementById(`${settingsModelElementId("sol", "thinkingBudgetTokens")}-control`)).toHaveFocus()
	})

	it("connection:<id> opens the card and form, focusing the URL", async () => {
		const settings = gatewaySettings()
		settings.connections.push({ ...settings.connections[0], id: "second", name: "Second" })
		setup({ settings, availability: envAvailable }, "connection:second")
		await flushFrame()
		await flushFrame()
		expect(screen.getByTestId("connection-form-second")).toBeInTheDocument()
		expect(document.getElementById(`${settingsConnectionElementId("second")}-control`)).toHaveFocus()
	})

	it("role:chat focuses Chat's picker", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable }, "role:chat")
		await flushFrame()
		await flushFrame()
		expect(screen.getAllByTestId("model-pick-button")[0]).toHaveFocus()
		expect(document.getElementById(settingsRowElementId("models.chat"))).toHaveClass("settings-target-highlight")
	})

	it("role:ask and role:generate open Advanced first", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable }, "role:generate")
		await flushFrame()
		await flushFrame()
		const row = document.getElementById(settingsRowElementId("models.background.generate")) as HTMLElement
		expect(row).toBeInTheDocument()
		expect(within(row).getByTestId("model-pick-button")).toHaveFocus()
	})

	it("old profile links land on Generate", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable }, "profiles")
		await flushFrame()
		await flushFrame()
		expect(document.getElementById(settingsRowElementId("models.background.generate"))).toHaveClass(
			"settings-target-highlight",
		)
	})

	it("the host's structured target becomes the string the shell parses", () => {
		expect(settingsTargetFromHost({ page: "models", modelId: "m1", field: "levels" })).toBe("model:m1:levels")
		expect(settingsTargetFromHost({ page: "models", modelId: "m1" })).toBe("model:m1")
		expect(settingsTargetFromHost({ page: "models", connectionId: "c1" })).toBe("connection:c1")
		expect(settingsTargetFromHost({ page: "models", role: "chat" })).toBe("role:chat")
		expect(settingsTargetFromHost({ page: "models" })).toBe("models")
	})
})

describe("Remote Config locks", () => {
	it("show in the row, disable the control, say who, and don't write", async () => {
		mocks.auth = { activeOrganization: { name: "Acme Corp", roles: ["member"] } }
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			managed: ["openAiBaseUrl", "openAiHeaders", "azureApiVersion"],
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		const form = within(screen.getByTestId("connection-form-gateway"))
		expect(form.getByLabelText("Base URL")).toBeDisabled()
		expect(form.getByLabelText("Header value")).toBeDisabled()
		expect(form.getByText(/Acme Corp sets the base URL, headers, Azure version here/)).toBeInTheDocument()
		expect(form.queryByRole("button", { name: "Add header" })).toBeNull()
		// Not locked: stays editable.
		expect(form.getByLabelText("Connection name")).not.toBeDisabled()
	})

	it("a managed model field shows the Managed tag and can't be edited", async () => {
		const settings = gatewaySettings()
		const host2 = createFakeHost({ settings, availability: envAvailable }).state()
		host2.effective.sol.contextWindow = { value: 200000, source: "managed" }
		setup({ settings, availability: envAvailable }, undefined, { modelSettings: host2 })
		await flush()
		const form = await openModel("sol")
		expect(form.getByLabelText("Context window")).toBeDisabled()
		expect(form.getByText("Managed")).toBeInTheDocument()
	})
})

describe("the model switch", () => {
	const row = () => within(screen.getByTestId("model-row-g54"))
	it("off keeps the model but hides it from pickers, and on brings it back", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		fireEvent.click(row().getByRole("switch", { name: /^Use / }))
		await flush()
		await flush()
		expect(savedRow("g54")?.enabled).toBe(false)
		expect(selectorDataFromModelSettings(host.state()).rows.map((entry) => entry.id)).not.toContain("g54")
		fireEvent.click(row().getByRole("switch", { name: /^Use / }))
		await flush()
		await flush()
		expect(savedRow("g54")).not.toHaveProperty("enabled")
		expect(selectorDataFromModelSettings(host.state()).rows.map((entry) => entry.id)).toContain("g54")
	})
	it("a thread already on a model that's off still names it, while pickers leave it out", () => {
		const settings = gatewaySettings()
		settings.models.find((entry) => entry.id === "g54")!.enabled = false
		const state = createFakeHost({ settings, availability: envAvailable }).state()
		expect(selectorDataFromModelSettings(state).rows.map((entry) => entry.id)).not.toContain("g54")
		expect(selectorDataFromModelSettings(state, ["g54"]).rows.map((entry) => entry.id)).toContain("g54")
	})
	it("turning off a model clears its allowed entry without changing unrelated entries", async () => {
		const settings = gatewaySettings()
		settings.subagents.allowed = [
			{ kind: "model", modelId: "g54", levels: [] },
			{ kind: "model", modelId: "sol", levels: ["medium"] },
		]
		setup({ settings, availability: envAvailable })
		await flush()
		fireEvent.click(row().getByRole("switch", { name: "Use GPT-5.4" }))
		await flush()
		expect(savedRow("g54")?.enabled).toBe(false)
		expect(host.state().settings.subagents.allowed).toEqual([{ kind: "model", modelId: "sol", levels: ["medium"] }])
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(1)
		expect(host.callsTo("setSubagentPolicy")).toHaveLength(0)
	})
	it("turning off a model clears all role picks and its allowed entry in the same save", async () => {
		const settings = gatewaySettings()
		const pick = { modelId: "g54", levelId: "default" }
		settings.roles.chat = pick
		settings.roles.ask = { enabled: true, pick }
		settings.roles.subagents = { kind: "model", pick }
		settings.roles.background.pick = pick
		settings.roles.background.overrides = { titles: pick, commitMessages: pick, generate: pick }
		settings.subagents.allowed = [{ kind: "model", modelId: "g54", levels: [] }]
		setup({ settings, availability: envAvailable })
		await flush()
		fireEvent.click(row().getByRole("switch", { name: "Use GPT-5.4" }))
		await flush()
		expect(savedRow("g54")?.enabled).toBe(false)
		expect(row().getByRole("switch", { name: "Use GPT-5.4" })).toHaveAttribute("aria-checked", "false")
		expect(host.state().settings.roles).toMatchObject({
			chat: null,
			ask: { enabled: false, pick: null },
			subagents: { kind: "thread", level: "inherit" },
			background: { pick: null, overrides: {} },
		})
		expect(host.state().settings.subagents.allowed).toEqual([])
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(1)
		expect(host.callsTo("setModelRoles")).toHaveLength(0)
		expect(host.callsTo("setSubagentPolicy")).toHaveLength(0)
	})
})

describe("the connection header", () => {
	it("puts Edit connection under the status, outside the row that opens and closes", async () => {
		const settings = gatewaySettings()
		settings.connections[0].auth = { kind: "keychain", secretRef: "settings:v1:connection:gateway:apiKey" }
		setup({ settings })
		await flush()
		const card = screen.getByTestId("connection-gateway")
		const edit = within(card).getByRole("button", { name: "Edit connection" })
		expect(edit.closest("button[aria-expanded]")).toBeNull()
		expect(edit.previousElementSibling).toHaveTextContent("Key missing")
		expect(edit.parentElement).toHaveClass("flex-col", "items-end")
		expect(page().getAllByText("Key missing")).toHaveLength(1)
		for (const row of screen.getAllByTestId(/^model-row-/)) {
			expect(within(row).queryByText("Key missing")).toBeNull()
			expect(within(row).queryByText("Can't run")).toBeNull()
		}
		fireEvent.click(edit)
		await flush()
		expect(page().queryByText("Key missing")).toBeNull()
		fireEvent.click(within(card).getByRole("button", { name: "Done editing" }))
		await flush()
		expect(page().getAllByText("Key missing")).toHaveLength(1)
	})

	it("has Edit connection up top, open or not, and it opens the form", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const card = () => within(screen.getByTestId("connection-gateway"))
		fireEvent.click(card().getAllByRole("button")[0])
		await flush()
		expect(card().queryByTestId("connection-form-gateway")).toBeNull()
		fireEvent.click(card().getByRole("button", { name: "Edit connection" }))
		await flush()
		expect(card().getByTestId("connection-form-gateway")).toBeInTheDocument()
		fireEvent.click(card().getByRole("button", { name: "Done editing" }))
		await flush()
		expect(card().queryByTestId("connection-form-gateway")).toBeNull()
	})
})

describe("host errors", () => {
	it("a change that trips the revision check goes through on the latest settings, with no error", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const original = mocks.host.saveConfiguredModels
		let refusals = 0
		mocks.host.saveConfiguredModels = async (request: { json: string }) => {
			if (refusals++ === 0) throw new Error("Settings changed in another window. Refresh and try again.")
			return original(request)
		}
		const form = await openModel("tuned")
		change("Max output tokens", "9000", form)
		await flush()
		await flush()
		await flush()
		expect(refusals).toBe(2)
		expect(savedRow("tuned")?.overrides.maxOutputTokens).toBe(9000)
		expect(form.queryByText(/nothing was saved/)).toBeNull()
		mocks.host.saveConfiguredModels = original
	})

	it("says a test stopped because settings changed, not that something wasn't saved", () => {
		expect(friendlyError(new Error("Settings changed during this request. Try again."))).toBe(
			"Settings changed while this was running, so it stopped. Try again.",
		)
	})

	it("names the field and rule when the host's validation refuses a value", () => {
		expect(friendlyError(new Error(JSON.stringify([{ path: ["connection", "baseUrl"], message: "Invalid URL" }])))).toBe(
			"The host refused this: connection.baseUrl: Invalid URL",
		)
	})

	it("a stale revision that keeps tripping says so, in place", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const original = mocks.host.saveConfiguredModels
		mocks.host.saveConfiguredModels = async () => {
			throw new Error("Settings changed in another window. Refresh and try again.")
		}
		const form = await openModel("tuned")
		change("Max output tokens", "9000", form)
		await flush()
		await flush()
		expect(form.getAllByText(/Settings kept changing while this saved, so nothing was saved/).length).toBeGreaterThan(0)
		expect(host.callsTo("getModelSettings").length).toBeGreaterThan(0)
		mocks.host.saveConfiguredModels = original
	})
})

describe("shared defaults", () => {
	const open = async () => {
		const settings = gatewaySettings()
		settings.connections[0].defaults = { contextWindow: 100000, temperature: 0.5, images: "yes" }
		setup({ settings, availability: envAvailable })
		await flush()
		const shared = within(screen.getByTestId("shared-defaults-gateway"))
		fireEvent.click(shared.getByRole("button", { name: /Shared defaults/ }))
		await flush()
		return within(screen.getByTestId("shared-defaults-gateway"))
	}
	const defaults = () => host.state().settings.connections[0].defaults

	it("clearing a number removes the key, so models inherit again", async () => {
		const shared = await open()
		change("Shared Context window", "", shared)
		await flush()
		await flush()
		expect(Object.hasOwn(defaults(), "contextWindow")).toBe(false)
		expect(host.wire()).not.toContain('"contextWindow":null')
	})

	it("a shared No clears the key so the catalog still decides; a shared 0 stays an answer", async () => {
		const shared = await open()
		fireEvent.click(
			within(shared.getByRole("radiogroup", { name: "Shared Can see images" })).getByRole("radio", { name: "No" }),
		)
		await flush()
		await flush()
		expect(Object.hasOwn(defaults(), "images")).toBe(false)
		change("Shared Temperature", "0", shared)
		await flush()
		await flush()
		expect(defaults().temperature).toBe(0)
	})
})

describe("the request preview", () => {
	it("shows the Authorization and custom header lines, masked", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		fireEvent.click(within(screen.getByTestId("request-preview")).getAllByRole("button")[0])
		await flush()
		await flush()
		const preview = within(screen.getByTestId("request-preview"))
		expect(preview.getByText(/authorization: \[redacted\]/)).toBeInTheDocument()
		expect(preview.getByText(/x-team: platform/)).toBeInTheDocument()
	})
})

describe("the Changed chip", () => {
	const overridden = () => {
		const settings = gatewaySettings()
		settings.connections[0].defaults = { temperature: 0.5 }
		settings.models.find((row) => row.id === "sol")!.overrides.temperature = 0.1
		settings.models.find((row) => row.id === "g54")!.overrides.temperature = 0.2
		return settings
	}
	const chip = () => screen.getByRole("button", { name: /^Changed/ })

	it("counts each model override once, lists it by model, and Reset takes it off the model", async () => {
		setup({ settings: overridden(), availability: envAvailable })
		await flush()
		expect(chip()).toHaveTextContent("Changed 2")
		fireEvent.click(chip())
		await flush()
		const result = within(screen.getByTestId("settings-result-model:sol:temperature"))
		expect(result.getByText("GPT-6 Sol: Temperature")).toBeInTheDocument()
		fireEvent.click(result.getByRole("button", { name: "Reset GPT-6 Sol: Temperature" }))
		await flush()
		await flush()
		expect(savedRow("sol")?.overrides).not.toHaveProperty("temperature")
		expect(savedRow("g54")?.overrides.temperature).toBe(0.2)
	})

	it("a model override opens that model's control", async () => {
		setup({ settings: overridden(), availability: envAvailable })
		await flush()
		fireEvent.click(chip())
		await flush()
		fireEvent.click(
			within(screen.getByTestId("settings-result-model:sol:temperature")).getByRole("button", {
				name: "GPT-6 Sol: Temperature",
			}),
		)
		await flushFrame()
		await flush()
		expect(screen.getByTestId("model-form-sol")).toBeInTheDocument()
	})
})

describe("host fix targets", () => {
	it("a pick the host refuses links to the control it names", async () => {
		const settings = gatewaySettings()
		setup({
			settings,
			availability: {
				...envAvailable,
				sol: {
					available: false,
					reason: "Connection credentials are missing",
					target: { page: "models", connectionId: "gateway" },
				},
			},
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Fix it" }))
		await flushFrame()
		await flush()
		expect(document.activeElement?.id).toBe(`${settingsConnectionElementId("gateway")}-control`)
	})

	it("a flagged model's Fix it lands on its Model ID field, not the connection", async () => {
		const settings = gatewaySettings()
		settings.models.find((model) => model.id === "sol")!.upstreamId = "model-id-needed"
		setup({
			settings,
			availability: {
				...envAvailable,
				sol: {
					available: false,
					reason: "This model has no model ID. Add it in Settings > Models.",
					target: { page: "models", modelId: "sol", field: "upstreamId" },
				},
			},
		})
		await flush()
		const row = screen.getByTestId("settings-page-models").querySelector(`[data-row="models.chat"]`) as HTMLElement
		expect(within(row).getByText(/no model ID, so this pick won't start/)).toBeInTheDocument()
		fireEvent.click(within(row).getByRole("button", { name: "Fix it" }))
		await flushFrame()
		await flush()
		expect(document.activeElement?.id).toBe(`${settingsModelElementId("sol", "upstreamId")}-control`)
		expect(screen.queryByTestId("connection-form-gateway")).toBeNull()
	})

	it("a flagged URL's Fix it lands on the Base URL field", async () => {
		const settings = gatewaySettings()
		settings.connections[0].baseUrl = "https://base-url-needed.invalid/"
		setup({
			settings,
			availability: {
				...envAvailable,
				sol: {
					available: false,
					reason: "This connection's base URL isn't valid. Fix it in Settings > Models.",
					target: { page: "models", connectionId: "gateway", field: "baseUrl" },
				},
			},
		})
		await flush()
		expect(page().getByText(/base URL isn't valid, so Chat.* won't start/)).toBeInTheDocument()
		fireEvent.click(page().getByRole("button", { name: "Fix it" }))
		await flushFrame()
		await flush()
		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Base URL" }))
	})

	it("a provider's flagged URL takes the fix link from its key field", async () => {
		const settings = gatewaySettings()
		settings.connections.push({
			id: "ant",
			name: "Claude",
			kind: "provider",
			providerId: "anthropic",
			baseUrl: "https://base-url-needed.invalid/",
			auth: { kind: "keychain", secretRef: "settings:v1:connection:ant:apiKey" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			options: {},
			secretRefs: {},
		})
		setup({ settings, availability: envAvailable }, "connection:ant")
		await flush()
		await flushFrame()
		await flush()
		const control = document.getElementById(`${settingsConnectionElementId("ant")}-control`)
		expect(control).toBe(screen.getByRole("textbox", { name: /Base URL/ }))
	})

	it("a migrated value isn't tagged, even under a shared default, until it's the user's", async () => {
		const settings = gatewaySettings()
		const sol = settings.models.find((model) => model.id === "sol")!
		settings.connections[0].defaults = { ...settings.connections[0].defaults, reasoning: "no" }
		sol.overrides = { ...sol.overrides, reasoning: "yes" }
		sol.migratedValues = ["reasoning"]
		setup({ settings, availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		expect(form.queryByRole("button", { name: "Reset Reasoning" })).toBeNull()
	})
})

describe("form layout", () => {
	const expectOrder = (elements: HTMLElement[]) => {
		for (let index = 1; index < elements.length; index++) {
			expect(elements[index - 1].compareDocumentPosition(elements[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		}
	}

	it("orders the model sections, More fields and footer actions", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		await openMore(form)
		expectOrder([
			form.getByLabelText("Model ID"),
			form.getByLabelText("Display name"),
			form.getByRole("radiogroup", { name: "Reasoning" }),
			form.getByText("Price and limits"),
			form.getByLabelText("Input $/1M"),
			form.getByLabelText("Output $/1M"),
			form.getByLabelText("Context window"),
			form.getByLabelText("Max output tokens"),
			form.getByRole("button", { name: /^More/ }),
			form.getByLabelText("Temperature"),
			form.getByRole("radiogroup", { name: "Streaming" }),
			form.getByRole("radiogroup", { name: "Prompt cache" }),
			form.getByLabelText("Cache read price"),
			form.getByLabelText("Cache write price"),
			...["Can read files", "Can use tools", "Can see images", "Verbosity", "API type"].map((name) =>
				form.getByRole("radiogroup", { name }),
			),
			form.getByLabelText("Max input tokens"),
			form.getByLabelText("Thinking budget"),
			form.getByText("Extra body params"),
			form.getByRole("button", { name: "Request preview" }),
			form.getByRole("button", { name: "Duplicate" }),
			form.getByRole("button", { name: "Remove" }),
		])
		expect(form.getByRole("button", { name: "Duplicate" }).parentElement).toBe(
			form.getByRole("button", { name: "Remove" }).parentElement,
		)
	})

	it("orders shared defaults like the model form and labels their inputs separately", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const shared = within(screen.getByTestId("shared-defaults-gateway"))
		fireEvent.click(shared.getByRole("button", { name: /Shared defaults/ }))
		await flush()
		expectOrder([
			shared.getByRole("radiogroup", { name: "Shared Reasoning" }),
			shared.getByText("Price and limits"),
			shared.getByLabelText("Shared Input"),
			shared.getByLabelText("Shared Output"),
			shared.getByLabelText("Shared Context window"),
			shared.getByLabelText("Shared Max output tokens"),
			shared.getByLabelText("Shared Temperature"),
			shared.getByRole("radiogroup", { name: "Shared Can use tools" }),
			shared.getByRole("radiogroup", { name: "Shared Can see images" }),
		])
	})
})

describe("manual model IDs", () => {
	const openPanel = async () => {
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			discovery: { gateway: { status: "no-list", models: [] } },
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add models" }))
		await flush()
		const panel = within(screen.getByTestId("add-models"))
		return { panel, input: panel.getByLabelText("Model IDs") }
	}

	it("Shift+Enter starts a new line and Enter adds every ID in the box", async () => {
		const { panel, input } = await openPanel()
		fireEvent.change(input, { target: { value: "model-a" } })
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
		await flush()
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(0)
		fireEvent.change(input, { target: { value: "model-a\nmodel-b" } })
		expect(panel.getByRole("button", { name: "Add 2 models" })).toBeEnabled()
		fireEvent.keyDown(input, { key: "Enter" })
		await flush()
		const models = host.callsTo("saveConfiguredModels")[0].models as { upstreamId: string }[]
		expect(models.map((row) => row.upstreamId)).toEqual(["model-a", "model-b"])
	})

	it("a pasted list with no connection list stays in the box to edit", async () => {
		const { input } = await openPanel()
		const notPrevented = fireEvent.paste(input, { clipboardData: { getData: () => "model-a\nmodel-b" } })
		expect(notPrevented).toBe(true)
	})

	it("says when an ID is already added, instead of a disabled button with no reason", async () => {
		const { panel, input } = await openPanel()
		const taken = host.state().settings.models[0].upstreamId
		fireEvent.change(input, { target: { value: taken } })
		expect(panel.getByRole("button", { name: "Add model" })).toBeDisabled()
		expect(panel.getByText(`${taken} is already added.`)).toBeInTheDocument()
		fireEvent.change(input, { target: { value: `${taken}, brand-new` } })
		expect(panel.getByRole("button", { name: "Add model" })).toBeEnabled()
	})

	it.each(["button", "Enter"])("adds a typed ID with no list via %s", async (submit) => {
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			discovery: { gateway: { status: "no-list", models: [] } },
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add models" }))
		await flush()
		const panel = within(screen.getByTestId("add-models"))
		expect(panel.getByRole("button", { name: "Add model" })).toBeDisabled()
		const input = panel.getByLabelText("Model IDs")
		fireEvent.change(input, { target: { value: "private/model" } })
		expect(panel.getByRole("button", { name: "Add model" })).toBeEnabled()
		if (submit === "Enter") fireEvent.keyDown(input, { key: "Enter" })
		else fireEvent.click(panel.getByRole("button", { name: "Add model" }))
		await flush()
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(1)
		expect(host.callsTo("saveConfiguredModels")[0].models).toEqual([
			expect.objectContaining({ upstreamId: "private/model", connectionId: "gateway" }),
		])
		expect(host.state().settings.models).toHaveLength(5)
		expect(screen.queryByTestId("add-models")).toBeNull()
	})
})

describe("connection problems", () => {
	it("shows an empty env var once on the header and hides it while editing", async () => {
		setup({
			settings: gatewaySettings(),
			availability: Object.fromEntries(
				["sol", "g54", "mini", "tuned"].map((id) => [
					id,
					{ available: false, reason: "Connection environment variable is empty" },
				]),
			),
		})
		await flush()
		expect(page().getAllByText("Env var empty")).toHaveLength(1)
		for (const row of screen.getAllByTestId(/^model-row-/)) {
			expect(within(row).queryByText(/Env var empty|Can't run/)).toBeNull()
		}
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		expect(page().queryByText("Env var empty")).toBeNull()
	})

	it("keeps a saved draft and its key after reopening Settings", async () => {
		const view = setup()
		await flush()
		change("API key", "sk-before-url")
		await flush()
		expect(host.callsTo("saveConnection")).toHaveLength(0)
		change("Base URL", "bad-url")
		await flush()
		expect(host.callsTo("saveConnection")).toHaveLength(0)
		expect(page().getByText(/That isn't a URL/)).toBeInTheDocument()
		change("Base URL", "https://saved.example/v1")
		await flush()
		expect(host.callsTo("saveConnection")).toHaveLength(1)
		const id = host.state().settings.connections[0].id
		expect(screen.getByTestId(`connection-form-${id}`)).toBeInTheDocument()
		expect(screen.getByTestId("add-models")).toBeInTheDocument()
		view.unmount()
		mocks.state.modelSettings = host.state()
		render(<SettingsShell onDone={() => {}} />)
		await flush()
		expect(screen.getByTestId(`connection-${id}`)).toHaveTextContent("https://saved.example/v1")
		fireEvent.click(page().getByRole("button", { name: "Edit connection" }))
		await flush()
		expect(page().getByLabelText("API key")).toHaveAttribute("placeholder", "Saved")
		expect(host.secrets[`settings:v1:connection:${id}:apiKey`]).toBe("sk-before-url")
		expect(host.callsTo("saveConnection")).toHaveLength(1)
	})
})
