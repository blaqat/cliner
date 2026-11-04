import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeHost, type FakeHost, gatewaySettings, modelRow } from "@/components/settings/models/modelsPage.fixture"
import ClineFreeModelLimitError from "./ClineFreeModelLimitError"
import ClinePassLimitError, { usageBilledModel } from "./ClinePassLimitError"

const mocks = vi.hoisted(() => ({
	host: {} as Record<string, unknown>,
	state: {} as Record<string, unknown>,
	catalog: { models: {} as Record<string, unknown>, defaultModelId: "" },
	updateApiConfigurationProto: vi.fn(),
	commitModelSelection: vi.fn(),
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/hooks/useProviderModels", () => ({ useProviderModels: () => mocks.catalog }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: new Proxy(
		{},
		{
			get: (_target, name: string) =>
				name === "updateApiConfigurationProto"
					? mocks.updateApiConfigurationProto
					: name === "commitModelSelection"
						? mocks.commitModelSelection
						: mocks.host[name],
		},
	),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
}))

let host: FakeHost
const onAccount = (providerId: string, upstreamId: string) => {
	const settings = gatewaySettings()
	settings.connections.push({
		id: "account",
		name: providerId,
		kind: "provider",
		providerId,
		baseUrl: null,
		auth: { kind: "sdk-account", providerId },
		headers: [],
		requestTimeoutMs: null,
		defaults: {},
		options: {},
		secretRefs: {},
	})
	settings.models.push(modelRow("current", "account", upstreamId, ""))
	settings.roles.chat = { modelId: "current", levelId: "default" }
	host = createFakeHost({ settings })
	mocks.host = host.client
	mocks.state = { mode: "act", modelSettings: host.state(), currentTaskItem: { id: "t" }, apiConfiguration: {} }
}

describe("limit errors with the new store in use", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.catalog = { models: { "deepseek/deepseek-v4-flash": {} }, defaultModelId: "fallback/default" }
	})
	it("the free-model switch moves this chat and the default to the paid model", async () => {
		onAccount("cline", "cline-free/deepseek-v4-flash")
		render(<ClineFreeModelLimitError message="try again in 1 hour" />)
		fireEvent.click(screen.getByText("Switch to Usage-Based billing"))
		await screen.findByText("Switched to Usage-Based billing")
		const { settings } = host.state()
		const paid = settings.models.find((m) => m.id === settings.roles.chat?.modelId)
		expect(paid?.upstreamId).toBe("deepseek/deepseek-v4-flash")
		expect(paid?.connectionId).toBe("account")
		expect(host.callsTo("setThreadModelSelection")[0]).toMatchObject({ taskId: "t", mode: "act", pick: settings.roles.chat })
		expect(mocks.commitModelSelection).not.toHaveBeenCalled()
	})
	it("the free-model switch isn't offered for a model that isn't Cline's", () => {
		onAccount("anthropic", "cline-free/deepseek-v4-flash")
		render(<ClineFreeModelLimitError message="" />)
		expect(screen.queryByText("Switch to Usage-Based billing")).toBeNull()
	})
	it("the ClinePass switch adds the Cline connection and moves off ClinePass", async () => {
		onAccount("cline-pass", "cline-pass/deepseek-v4-flash")
		render(<ClinePassLimitError message="limit" />)
		fireEvent.click(screen.getByText("Switch to Usage-Based billing"))
		await screen.findByText("Switched to Usage-Based billing")
		const { settings } = host.state()
		const paid = settings.models.find((m) => m.id === settings.roles.chat?.modelId)
		const connection = settings.connections.find((c) => c.id === paid?.connectionId)
		expect(connection).toMatchObject({ providerId: "cline", auth: { kind: "sdk-account", providerId: "cline" } })
		expect(paid?.upstreamId).toBe("deepseek/deepseek-v4-flash")
		expect(mocks.updateApiConfigurationProto).not.toHaveBeenCalled()
	})
	it("the ClinePass switch says where to go instead of claiming success when no model is known", async () => {
		onAccount("cline-pass", "cline-pass/x")
		mocks.catalog = { models: {}, defaultModelId: "" }
		render(<ClinePassLimitError message="limit" />)
		fireEvent.click(screen.getByText("Switch to Usage-Based billing"))
		expect(await screen.findByText(/Settings > Models/)).toBeTruthy()
		expect(screen.queryByText("Switched to Usage-Based billing")).toBeNull()
		expect(host.state().settings.roles.chat?.modelId).toBe("current")
	})
	it("a host refusal shows, and isn't reported as switched", async () => {
		onAccount("cline-pass", "cline-pass/deepseek-v4-flash")
		mocks.host = { ...host.client, saveConnection: () => Promise.reject(new Error("not allowed")) }
		render(<ClinePassLimitError message="limit" />)
		fireEvent.click(screen.getByText("Switch to Usage-Based billing"))
		await waitFor(() => expect(screen.getByText(/Failed to switch provider/)).toBeTruthy())
		expect(screen.queryByText("Switched to Usage-Based billing")).toBeNull()
	})
	it("usageBilledModel finds the same slug, else the catalog's default", () => {
		expect(usageBilledModel("cline-pass/kimi", ["moonshot/kimi", "other"], "d")).toBe("moonshot/kimi")
		expect(usageBilledModel("exact", ["exact"], "d")).toBe("exact")
		expect(usageBilledModel("none", ["other"], "d")).toBe("d")
		expect(usageBilledModel(undefined, [], "")).toBe("")
	})
})
