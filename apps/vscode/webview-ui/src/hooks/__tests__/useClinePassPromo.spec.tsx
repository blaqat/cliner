import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useClinePassPromo } from "../useClinePassPromo"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@/context/ClineAuthContext", () => ({
	useClineAuth: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	UiServiceClient: {
		openUrl: vi.fn(() => Promise.resolve({})),
	},
}))

const mockNavigateToSettings = vi.fn()

const mockExtensionState = (overrides: Record<string, unknown> = {}) => {
	vi.mocked(useExtensionState).mockReturnValue({
		environment: "production",
		navigateToSettings: mockNavigateToSettings,
		remoteConfigSettings: undefined,
		mode: "act",
		...overrides,
	} as any)
}

describe("useClinePassPromo", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(useClineAuth).mockReturnValue({ clineUser: null } as any)
		mockExtensionState()
	})

	it("is enabled when no remote config restricts providers", () => {
		const { result } = renderHook(() => useClinePassPromo())
		expect(result.current.isClinePassEnabled).toBe(true)
	})

	it("is disabled in self-hosted mode", () => {
		mockExtensionState({ environment: "selfHosted" })
		const { result } = renderHook(() => useClinePassPromo())
		expect(result.current.isClinePassEnabled).toBe(false)
	})

	it("is disabled when the environment is unknown", () => {
		mockExtensionState({ environment: undefined })
		const { result } = renderHook(() => useClinePassPromo())
		expect(result.current.isClinePassEnabled).toBe(false)
	})

	it("is disabled when the org remote config excludes cline-pass", () => {
		mockExtensionState({ remoteConfigSettings: { remoteConfiguredProviders: ["anthropic", "openrouter"] } })
		const { result } = renderHook(() => useClinePassPromo())
		expect(result.current.isClinePassEnabled).toBe(false)
	})

	it("stays enabled when the org remote config includes cline-pass", () => {
		mockExtensionState({ remoteConfigSettings: { remoteConfiguredProviders: ["anthropic", "cline-pass"] } })
		const { result } = renderHook(() => useClinePassPromo())
		expect(result.current.isClinePassEnabled).toBe(true)
	})

	it("before the setup has moved, opens Settings, which says why", async () => {
		const { result } = renderHook(() => useClinePassPromo())
		expect(result.current.isUsingClinePass).toBe(false)
		await result.current.switchToClinePassProvider()
		expect(mockNavigateToSettings).toHaveBeenCalledWith("models")
	})
})
