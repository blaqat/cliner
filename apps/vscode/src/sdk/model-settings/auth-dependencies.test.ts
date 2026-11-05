import { describe, expect, it, vi } from "vitest"
import { modelAuthDependencies } from "./auth-dependencies"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import { resolveConnectionConfig } from "./request-adapter"

const mocks = vi.hoisted(() => ({ getProviderConfig: vi.fn() }))
vi.mock("../provider-migration", () => ({ getProviderSettingsManager: () => ({ getProviderConfig: mocks.getProviderConfig }) }))

const stateWith = (secrets: Record<string, string>) => ({
	connectionSecrets: new InMemoryConnectionSecretStore(),
	getSecretKey: (key: string) => secrets[key],
})

describe("account connections", () => {
	it("Oracle uses the token its sign-in stores, which the SDK's provider file never sees", async () => {
		mocks.getProviderConfig.mockReset()
		const deps = modelAuthDependencies(stateWith({ ocaApiKey: "signed-in-token" }) as never)
		expect(await deps.sdkAccount!("oca")).toMatchObject({ providerId: "oca", apiKey: "signed-in-token" })
		expect(mocks.getProviderConfig).not.toHaveBeenCalled()
	})
	it("reads Oracle's token at each build, so a refreshed one is what's used", async () => {
		const secrets = { ocaApiKey: "first" }
		const deps = modelAuthDependencies(stateWith(secrets) as never)
		await deps.sdkAccount!("oca")
		secrets.ocaApiKey = "refreshed"
		expect((await deps.sdkAccount!("oca")).apiKey).toBe("refreshed")
	})
	it("not signed in to Oracle says so, instead of naming the SDK", async () => {
		mocks.getProviderConfig.mockReset().mockReturnValue(undefined)
		const deps = modelAuthDependencies(stateWith({}) as never)
		await expect(deps.sdkAccount!("oca")).rejects.toThrow("Not signed in to Oracle")
	})
	it("a new oca connection resolves end to end, with the token as its key", async () => {
		const deps = modelAuthDependencies(stateWith({ ocaApiKey: "signed-in-token" }) as never)
		const config = await resolveConnectionConfig(
			{
				id: "c",
				name: "Oracle",
				kind: "provider",
				providerId: "oca",
				baseUrl: null,
				auth: { kind: "sdk-account", providerId: "oca" },
				headers: [],
				requestTimeoutMs: null,
				defaults: {},
				options: {},
				secretRefs: {},
			},
			deps,
		)
		expect(config).toMatchObject({ providerId: "oca", apiKey: "signed-in-token" })
	})
	it("another provider's account never reads Oracle's token", async () => {
		mocks.getProviderConfig.mockReset().mockReturnValue({ providerId: "cline", apiKey: "cline-key" })
		const deps = modelAuthDependencies(stateWith({ ocaApiKey: "signed-in-token" }) as never)
		expect((await deps.sdkAccount!("cline")).apiKey).toBe("cline-key")
	})
})
