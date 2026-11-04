import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeHost, type FakeHost, gatewaySettings } from "@/components/settings/models/modelsPage.fixture"
import { useClinePassPromo } from "./useClinePassPromo"

const mocks = vi.hoisted(() => ({
	host: {} as Record<string, unknown>,
	state: {} as Record<string, unknown>,
	handleModeFieldChange: vi.fn(),
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => ({ clineUser: undefined }) }))
vi.mock("@/components/settings/utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleModeFieldChange: mocks.handleModeFieldChange }),
}))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: new Proxy({}, { get: (_target, name: string) => mocks.host[name] }),
	UiServiceClient: {},
}))

let host: FakeHost
describe("the ClinePass promo with the new store in use", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		host = createFakeHost({ settings: gatewaySettings() })
		mocks.host = host.client
		mocks.state = {
			mode: "act",
			environment: "production",
			navigateToSettings: vi.fn(),
			modelSettings: host.state(),
			// The old selection says ClinePass; nothing runs on it.
			apiConfiguration: { actModeApiProvider: "cline-pass", planModeApiProvider: "cline-pass" },
		}
	})
	it("reads what's selected from the new store", () => {
		const { result } = renderHook(() => useClinePassPromo())
		expect(result.current.isUsingClinePass).toBe(false)
	})
	it("adds the connection and opens it, without old writes or changing what runs", async () => {
		const chat = host.state().settings.roles.chat
		const { result } = renderHook(() => useClinePassPromo())
		await result.current.switchToClinePassProvider()
		const connection = host.state().settings.connections.find((c) => c.kind === "provider" && c.providerId === "cline-pass")
		expect(connection).toBeDefined()
		await waitFor(() => expect(mocks.state.navigateToSettings).toHaveBeenCalledWith(`connection:${connection?.id}`))
		expect(mocks.handleModeFieldChange).not.toHaveBeenCalled()
		expect(host.state().settings.roles.chat).toEqual(chat)
	})
	it("a refusal still lands on the page, not nowhere", async () => {
		mocks.host = { ...host.client, saveConnection: () => Promise.reject(new Error("not allowed")) }
		const { result } = renderHook(() => useClinePassPromo())
		await result.current.switchToClinePassProvider()
		expect(mocks.state.navigateToSettings).toHaveBeenCalledWith("models")
	})
})
