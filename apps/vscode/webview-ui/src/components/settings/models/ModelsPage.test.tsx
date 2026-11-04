import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
		expect(page().getByRole("button", { name: "vLLM" })).toBeInTheDocument()
		expect(page().getAllByTestId("model-pick-button")[0]).toHaveTextContent("No models yet")
		expect(host.callsTo("saveConnection")).toHaveLength(0)
	})

	it("won't test a connection without a URL, and says why", async () => {
		setup()
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Test connection" }))
		await flush()
		expect(page().getByText("Add a base URL first.")).toBeInTheDocument()
		expect(host.callsTo("saveConnection")).toHaveLength(0)
	})
})

describe("adding many models from one base URL", () => {
	const startDraft = async (options: FakeHostOptions = {}) => {
		setup(options)
		await flush()
		change("Base URL", "https://gw.example/v1")
		change("API key", "sk-live-1234")
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Test connection" }))
		await flush()
		await flush()
	}

	it("saves the draft, tests it, then ticks from /models with the same URL and key", async () => {
		await startDraft()
		const [saved] = host.callsTo("saveConnection")
		expect(saved.connection).toMatchObject({
			baseUrl: "https://gw.example/v1",
			name: "gw.example",
			kind: "openai-compatible",
		})
		expect(saved.secrets).toEqual([{ field: "apiKey", operation: "set", value: "sk-live-1234" }])
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
		expect(page().getByText(/Added 2 models/)).toBeInTheDocument()
	})

	it("the first model added leaves Chat and Background text blank, and says why nothing can run", async () => {
		await startDraft()
		const add = within(screen.getByTestId("add-models"))
		await waitFor(() => expect(add.getByRole("checkbox", { name: /gpt-6-sol/ })).toBeInTheDocument())
		fireEvent.click(add.getByRole("checkbox", { name: /gpt-6-sol/ }))
		fireEvent.click(add.getByRole("button", { name: "Add 1 model" }))
		await flush()
		await flush()
		expect(host.callsTo("setModelRoles")).toHaveLength(0)
		expect(host.state().settings.roles.chat).toBeNull()
		expect(host.state().settings.roles.background.pick).toBeNull()
		expect(page().getByText(/Threads need a Chat model/)).toBeInTheDocument()
		expect(page().getByText(/need a Background text model/)).toBeInTheDocument()
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
		fireEvent.click(page().getByRole("button", { name: "Add model" }))
		await flush()
		const panel = within(screen.getByTestId("add-models"))
		await waitFor(() => expect(panel.getByRole("checkbox", { name: /gpt-9/ })).toBeInTheDocument())
		expect(panel.queryByText("text-embedding-3-large")).toBeNull()
	})

	it("a connection with no /models says so and takes a pasted list of IDs", async () => {
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			discovery: { gateway: { status: "no-list", manualEntry: true, models: [] } },
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add model" }))
		await flush()
		const panel = within(screen.getByTestId("add-models"))
		expect(panel.getByText(/has no \/models, so type or paste IDs/)).toBeInTheDocument()
		const input = panel.getByLabelText("Type or paste model IDs")
		fireEvent.paste(input, { clipboardData: { getData: () => "model-a\nmodel-b, model-c model-a" } })
		await flush()
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
		fireEvent.click(page().getByRole("button", { name: "Add model" }))
		await flush()
		const panel = within(screen.getByTestId("add-models"))
		await waitFor(() => expect(panel.getByRole("checkbox", { name: /qwen3-coder/ })).toBeInTheDocument())
		fireEvent.change(panel.getByLabelText("Filter /models, or paste IDs"), { target: { value: "secret-model" } })
		fireEvent.click(panel.getByRole("button", { name: /Add “secret-model” by ID/ }))
		await flush()
		expect(panel.getByRole("checkbox", { name: /secret-model/ })).toBeInTheDocument()
		expect(panel.getByText("not on /models")).toBeInTheDocument()
		expect(panel.getByRole("button", { name: "Add 1 model" })).toBeInTheDocument()
	})

	it("auth and network failures while listing say different things and still allow manual IDs", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable, discovery: { gateway: { status: "auth", models: [] } } })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add model" }))
		await flush()
		expect(screen.getByText(/turned the key down/)).toBeInTheDocument()
		expect(within(screen.getByTestId("add-models")).getByLabelText("Type or paste model IDs")).toBeInTheDocument()
	})
})

describe("connection test", () => {
	const testResult = async (status: "ok" | "auth" | "network" | "no-list") => {
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			test: {
				gateway: {
					status,
					models:
						status === "ok"
							? [{ upstreamId: "gpt-6-sol", name: "x", classification: "unknown", source: "discovered" }]
							: [],
				},
			},
		})
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Test" }))
		await flush()
		await flush()
		return within(screen.getByTestId("connection-test-result"))
	}

	it("ok says what it proved", async () => {
		const result = await testResult("ok")
		expect(result.getByText(/Reached ai\.acme\.example in \d+ ms/)).toBeInTheDocument()
		expect(result.getByText("Key from AI_GATEWAY_KEY accepted")).toBeInTheDocument()
		expect(result.getByText("/models lists 1 chat model")).toBeInTheDocument()
	})
	it("auth says the key was refused and offers the fix", async () => {
		const result = await testResult("auth")
		expect(result.getByText(/AI_GATEWAY_KEY is empty in this window, or the server refused it/)).toBeInTheDocument()
		expect(result.getByRole("button", { name: "Edit the key" })).toBeInTheDocument()
		expect(page().getByText("Key refused")).toBeInTheDocument()
	})
	it("network says it can't reach the server", async () => {
		const result = await testResult("network")
		expect(result.getByText(/Can't reach ai\.acme\.example/)).toBeInTheDocument()
		expect(result.getByRole("button", { name: "Edit the URL" })).toBeInTheDocument()
		expect(page().getByText("Can't reach it")).toBeInTheDocument()
	})
	it("no-list is fine, and doesn't claim the key works", async () => {
		const result = await testResult("no-list")
		expect(result.getByText(/has no \/models \(404\)/)).toBeInTheDocument()
		expect(result.queryByText(/accepted/)).toBeNull()
		expect(page().getByText("No /models")).toBeInTheDocument()
	})
	it("after a list, a model that's gone says so and can be kept", async () => {
		await testResult("ok")
		expect(within(screen.getByTestId("model-row-g54")).getByText("Not on /models")).toBeInTheDocument()
		fireEvent.click(within(screen.getByTestId("model-row-g54")).getByRole("button", { name: "Keep it" }))
		await flush()
		expect(within(screen.getByTestId("model-row-g54")).queryByText("Not on /models")).toBeNull()
	})
})

describe("the list", () => {
	it("shows every model under its connection, with levels, status and Duplicate", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const sol = within(screen.getByTestId("model-row-sol"))
		expect(sol.getByText("GPT-6 Sol")).toBeInTheDocument()
		expect(sol.getByText("Low–XHigh")).toBeInTheDocument()
		expect(sol.getByText(/gpt-6-sol · 400K · \$5 \/ \$20/)).toBeInTheDocument()
		expect(sol.getByText("Ready")).toBeInTheDocument()
		expect(sol.getByRole("button", { name: "Duplicate GPT-6 Sol" })).toBeInTheDocument()
		expect(within(screen.getByTestId("model-row-mini")).getByText("Low–High")).toBeInTheDocument()
		expect(page().getByText("All 4 show in the composer and every selector.")).toBeInTheDocument()
	})

	it("an unknown context window runs at ~128K, marked, and never saves 128K", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const row = screen.getByTestId("model-row-tuned")
		expect(within(row).getByText("~128K")).toHaveAttribute("title", expect.stringContaining("plans with 128K"))
		expect(within(row).getByText("Ready")).toBeInTheDocument()
		// The ~ already says it, so context doesn't count in the tag.
		expect(within(row).getByText("3 unknown")).toBeInTheDocument()
		expect(within(row).getByText("Levels unknown")).toBeInTheDocument()
		const form = await openModel("tuned")
		expect(form.getByText(/Unknown: Cline plans with 128K and marks the ring with ~/)).toBeInTheDocument()
		expect(form.getByLabelText("Context window")).toHaveValue("")
		expect(host.state().settings.models.find((model) => model.id === "tuned")?.overrides.contextWindow).toBeUndefined()
		fireEvent.click(form.getByRole("button", { name: "What happens" }))
		expect(within(screen.getByTestId("unknown-explained")).getByText(/Cline plans with 128K/)).toBeInTheDocument()
		expect(within(screen.getByTestId("unknown-explained")).getByText(/Cline sends no limit/)).toBeInTheDocument()
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
		expect(within(row).getByText(/Company gateway: key missing, so threads on this pick won't start/)).toBeInTheDocument()
		expect(within(row).getByRole("button", { name: "Fix it" })).toBeInTheDocument()
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

	it("has every 6b field", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		for (const label of [
			"Model ID",
			"Display name",
			"Context window",
			"Max output tokens",
			"Temperature",
			"Input",
			"Output",
		]) {
			expect(form.getByLabelText(label)).toBeInTheDocument()
		}
		for (const group of ["Images", "Tools", "Reasoning", "Verbosity"]) {
			expect(form.getByRole("radiogroup", { name: group })).toBeInTheDocument()
		}
		expect(form.getByRole("button", { name: "Detect" })).toBeInTheDocument()
		expect(form.getByRole("button", { name: /Start from a preset/ })).toBeInTheDocument()
		expect(form.getByRole("button", { name: "Test this model" })).toBeInTheDocument()
		expect(form.getByRole("button", { name: "Remove" })).toBeInTheDocument()
		expect(form.getByRole("switch", { name: "Free" })).toBeInTheDocument()
		// How each level maps.
		const table = within(form.getByTestId("level-table"))
		expect(table.getByText("reasoning.effort")).toBeInTheDocument()
		for (const level of ["Default", "Low", "Medium", "High", "XHigh"]) {
			expect(table.getByRole("switch", { name: `Offer ${level}` })).toBeInTheDocument()
		}
		expect(table.getByText("Nothing sent")).toBeInTheDocument()
		expect(table.getByLabelText("High is sent as")).toHaveValue("high")
		expect(form.getByRole("button", { name: "Add param" })).toBeInTheDocument()
		// More.
		fireEvent.click(form.getByRole("button", { name: /^More/ }))
		await flush()
		for (const label of ["Max input tokens", "Thinking budget", "Cache read price", "Cache write price"]) {
			expect(form.getByLabelText(label)).toBeInTheDocument()
		}
		for (const group of ["Streaming", "Prompt cache", "Files", "System role", "API type"]) {
			expect(form.getByRole("radiogroup", { name: group })).toBeInTheDocument()
		}
		expect(form.getByRole("radio", { name: "developer" })).toHaveAttribute("aria-checked", "true")
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
		expect(form.getByText(/can't offer levels until you say whether it can reason/)).toBeInTheDocument()
		fireEvent.click(within(form.getByRole("radiogroup", { name: "Reasoning" })).getByRole("radio", { name: "Yes" }))
		await flush()
		await flush()
		expect(savedRow("tuned")?.overrides.reasoning).toBe("yes")
		expect(savedRow("tuned")?.overrides.levels?.map((level) => level.id)).toEqual(["default", "low", "medium", "high"])
		expect(within(screen.getByTestId("model-row-tuned")).getByText("Low–High")).toBeInTheDocument()
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

	it("a preset fills from the catalog, never prices and never what's set", async () => {
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			catalog: {
				anthropic: {
					"opus-4.5": {
						name: "Opus 4.5",
						contextWindow: 200000,
						maxTokens: 8192,
						supportsImages: true,
						inputPrice: 5,
						outputPrice: 25,
						supportsReasoning: true,
					} as never,
				},
			},
		})
		await flush()
		const form = await openModel("tuned")
		fireEvent.click(form.getByRole("button", { name: /Start from a preset/ }))
		await flush()
		await flush()
		expect(form.getByText(/Presets never fill in prices/)).toBeInTheDocument()
		fireEvent.click(within(form.getByTestId("model-presets")).getByRole("button", { name: "Opus 4.5" }))
		await flush()
		await flush()
		const overrides = savedRow("tuned")?.overrides
		expect(overrides).toMatchObject({
			contextWindow: 200000,
			maxOutputTokens: 8192,
			images: "yes",
			reasoning: "yes",
			tools: "yes",
		})
		expect(overrides).not.toHaveProperty("inputPrice")
		expect(overrides).not.toHaveProperty("outputPrice")
	})

	it("Detect fills unknowns only, and never what's set", async () => {
		setup({
			settings: gatewaySettings(),
			availability: envAvailable,
			detected: { contextWindow: 200000, tools: "no", maxOutputTokens: 8000 },
		})
		await flush()
		const form = await openModel("tuned")
		fireEvent.click(form.getByRole("button", { name: "Detect" }))
		await flush()
		await flush()
		expect(savedRow("tuned")?.overrides.contextWindow).toBe(200000)
		expect(savedRow("tuned")?.overrides.maxOutputTokens).toBe(8000)
		expect(savedRow("tuned")?.overrides.tools).toBe("yes")
		expect(form.getByRole("status")).toHaveTextContent(/Detect found 2/)
	})

	it("Test this model and the request preview call the real RPCs and show what they return", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable, modelTest: "inference-failed" })
		await flush()
		const form = await openModel("sol")
		fireEvent.click(form.getByRole("button", { name: "Test this model" }))
		await flush()
		await flush()
		expect(host.callsTo("testConfiguredModel")[0].pick).toEqual({ modelId: "sol", levelId: "xhigh" })
		expect(form.getByRole("status")).toHaveTextContent(/gpt-6-sol didn't answer/)
		fireEvent.click(form.getByRole("button", { name: /Preview the request/ }))
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
		fireEvent.click(form.getByRole("button", { name: /Preview the request/ }))
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
		change("Shared Input, per 1M", "3", shared)
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
		fireEvent.click(form.getByRole("button", { name: "Reset Input" }))
		await flush()
		await flush()
		expect(savedRow("sol")?.overrides).not.toHaveProperty("inputPrice")
		expect(savedRow("sol")?.overrides.outputPrice).toBe(20)
		expect(form.queryByRole("button", { name: "Reset Input" })).toBeNull()
		expect(form.getByLabelText("Input")).toHaveValue("")
		expect(form.getByLabelText("Input")).toHaveAttribute("placeholder", "2")
		expect(form.getByRole("button", { name: "Reset Output" })).toBeInTheDocument()
	})

	it("an inherited capability is marked as inherited", async () => {
		const settings = gatewaySettings()
		settings.connections[0].defaults = { ...settings.connections[0].defaults, images: "no" }
		settings.models[3].overrides = { tools: "yes" }
		setup({ settings, availability: envAvailable })
		await flush()
		const form = await openModel("tuned")
		const yes = within(form.getByRole("radiogroup", { name: "Images" })).getByRole("radio", { name: "No" })
		expect(yes).toHaveAttribute("aria-checked", "true")
		expect(yes).toHaveAttribute("title", "From this connection's shared defaults")
	})
})

describe("duplicate", () => {
	it("makes a blank-ID copy in place, saves nothing until it has an ID, copies no secrets and assigns no roles", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		fireEvent.click(within(screen.getByTestId("model-row-sol")).getByRole("button", { name: "Duplicate GPT-6 Sol" }))
		await flush()
		await flush()
		expect(host.callsTo("duplicateConfiguredModel")[0]).toEqual({ modelId: "sol" })
		expect(host.callsTo("saveConfiguredModels")).toHaveLength(0)
		expect(page().getByText("Copied GPT-6 Sol. Type the new ID.")).toBeInTheDocument()
		const input = page()
			.getAllByLabelText("Model ID")
			.find((box) => (box as HTMLInputElement).value === "") as HTMLInputElement
		expect(input).toHaveFocus()
		const form = within(input.closest("[data-testid^=model-form-]") as HTMLElement)
		expect(form.getByRole("button", { name: "Test this model" })).toBeDisabled()
		expect(form.getByRole("button", { name: "Test this model" })).toHaveAttribute("title", "Type the model ID first.")
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
		fireEvent.click(within(screen.getByTestId("model-row-sol")).getByRole("button", { name: "Duplicate GPT-6 Sol" }))
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
		expect(input).toHaveAttribute("placeholder", "Saved in the keychain. Type to replace it.")
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
		fireEvent.click(page().getByRole("button", { name: "Remove the saved value" }))
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
			fireEvent.click(page().getByRole("button", { name: "Edit" }))
			await flush()
		}

		it("removes an optional secret and its reference in one save", async () => {
			await open()
			fireEvent.click(page().getByRole("button", { name: "Remove the saved value" }))
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
			expect(page().getAllByRole("button", { name: "Remove the saved value" })).toHaveLength(1)
			expect(page().getByText(/can't work without it/)).toBeInTheDocument()
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
		fireEvent.click(form.getByRole("button", { name: /^More/ }))
		await flush()
		expect(form.queryByLabelText("Azure API version")).toBeNull()
	})
})

describe("other providers", () => {
	const openChooser = async (options: FakeHostOptions = {}) => {
		setup({ settings: gatewaySettings(), availability: envAvailable, ...options })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Add a model from another provider" }))
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
		fireEvent.click(page().getByRole("button", { name: "Add a model from another provider" }))
		await flush()
		await flush()
		const chooser = within(screen.getByTestId("provider-chooser"))
		expect(chooser.getByRole("button", { name: "Anthropic" })).toBeInTheDocument()
		expect(chooser.queryByRole("button", { name: "Groq" })).toBeNull()
		expect(chooser.queryByRole("button", { name: "Amazon Bedrock" })).toBeNull()
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
		fireEvent.click(panel.getByRole("button", { name: "Add 1 model" }))
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
		fireEvent.click(open.getByRole("button", { name: "Edit" }))
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
		fireEvent.click(open.getByRole("button", { name: "Edit" }))
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
	it("shows what depends on a model in place, and lets each be fixed", async () => {
		const settings = gatewaySettings()
		settings.subagents.allowed = [{ kind: "model", modelId: "mini", levels: ["low"] }]
		settings.roles.background.overrides = { titles: { modelId: "mini", levelId: "low" } }
		setup({ settings, availability: envAvailable, threadDependencies: { mini: ["t1", "t2"] } })
		await flush()
		const form = await openModel("mini")
		fireEvent.click(form.getByRole("button", { name: "Remove" }))
		await flush()
		fireEvent.click(within(screen.getByTestId("remove-flow")).getByRole("button", { name: "Remove" }))
		await flush()
		await flush()
		const list = within(screen.getByTestId("remove-dependencies"))
		expect(list.getByText("Background text uses it.")).toBeInTheDocument()
		expect(list.getByText("Thread titles uses it.")).toBeInTheDocument()
		expect(list.getByText(/It's on the list of models subagents can choose/)).toBeInTheDocument()
		expect(list.queryByRole("button", { name: "Open history" })).toBeNull()
		expect(host.state().settings.models.some((model) => model.id === "mini")).toBe(true)
		// Fix them one at a time.
		fireEvent.click(list.getAllByRole("button", { name: "Clear it" })[0])
		await flush()
		await flush()
		expect(host.state().settings.roles.background.pick).toBeNull()
		expect(list.queryByText("Background text uses it.")).toBeNull()
		fireEvent.click(list.getByRole("button", { name: "Take it off the list" }))
		await flush()
		await flush()
		expect(host.state().settings.subagents.allowed).toEqual([])
		expect(list.getAllByRole("listitem").length).toBeGreaterThan(0)
	})

	it("says how many saved threads use a model, and deletes it anyway", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable, threadDependencies: { tuned: ["t1", "t2", "t3"] } })
		await flush()
		const form = await openModel("tuned")
		fireEvent.click(form.getByRole("button", { name: "Remove" }))
		await flush()
		await flush()
		const flow = within(screen.getByTestId("remove-flow"))
		expect(flow.getByText(/3 saved threads use this\. They'll ask you to pick a model when reopened\./)).toBeInTheDocument()
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

	it("a connection has to lose its models first: offers that, then removes it", async () => {
		const settings = gatewaySettings()
		settings.roles.chat = null
		settings.roles.background.pick = null
		setup({ settings, availability: envAvailable })
		await flush()
		fireEvent.click(page().getByRole("button", { name: "Remove connection" }))
		await flush()
		expect(screen.getByText("Remove Company gateway and its 4 models?")).toBeInTheDocument()
		fireEvent.click(within(screen.getByTestId("remove-flow")).getByRole("button", { name: "Remove" }))
		await flush()
		await flush()
		const list = within(screen.getByTestId("remove-dependencies"))
		expect(list.getByText(/Its 4 models have to go first/)).toBeInTheDocument()
		fireEvent.click(list.getByRole("button", { name: "Remove them" }))
		await flush()
		await flush()
		await flush()
		expect(host.state().settings.models).toHaveLength(0)
		fireEvent.click(within(screen.getByTestId("remove-flow")).getByRole("button", { name: "Try removing again" }))
		await flush()
		await flush()
		expect(host.state().settings.connections).toHaveLength(0)
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

describe("host errors", () => {
	it("a stale revision refreshes and asks to retry, in place", async () => {
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
		expect(form.getAllByText(/Settings changed elsewhere, so nothing was saved/).length).toBeGreaterThan(0)
		expect(host.callsTo("getModelSettings").length).toBeGreaterThan(0)
		mocks.host.saveConfiguredModels = original
	})
})

describe("shared defaults", () => {
	const open = async () => {
		const settings = gatewaySettings()
		settings.connections[0].defaults = { contextWindow: 100000, temperature: 0.5, images: "yes", free: true }
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

	it("Unknown removes the key; zero and false stay answers", async () => {
		const shared = await open()
		fireEvent.click(within(shared.getByRole("radiogroup", { name: "Shared Images" })).getByRole("radio", { name: "Unknown" }))
		await flush()
		await flush()
		expect(Object.hasOwn(defaults(), "images")).toBe(false)
		change("Shared Temperature", "0", shared)
		await flush()
		await flush()
		expect(defaults().temperature).toBe(0)
		fireEvent.click(shared.getByRole("switch", { name: "Shared Free" }))
		await flush()
		await flush()
		expect(defaults().free).toBe(false)
	})
})

describe("the request preview", () => {
	it("shows the Authorization and custom header lines, masked", async () => {
		setup({ settings: gatewaySettings(), availability: envAvailable })
		await flush()
		const form = await openModel("sol")
		fireEvent.click(form.getByRole("button", { name: /request/i }))
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
			within(screen.getByTestId("settings-result-model:sol:temperature")).getByRole("button", { name: "GPT-6 Sol: Temperature" }),
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
		const row = screen.getByTestId("settings-page-models").querySelector(`[data-row="models.chat"]`) as HTMLElement
		fireEvent.click(within(row).getByRole("button", { name: "Fix it" }))
		await flushFrame()
		await flush()
		expect(document.activeElement?.id).toBe(`${settingsConnectionElementId("gateway")}-control`)
	})
})
