import { beforeEach, describe, expect, it, vi } from "vitest"
import { ensureAccountConnection, moveToAccountModel } from "./configuredModelActions"
import { createFakeHost, type FakeHost, gatewaySettings } from "./modelsPage.fixture"

const mocks = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: new Proxy({}, { get: (_target, name: string) => mocks.host[name] }),
}))

let host: FakeHost
const setup = (settings = gatewaySettings()) => {
	host = createFakeHost({ settings })
	mocks.host = host.client
	return settings
}
const move = (leaving?: string) =>
	moveToAccountModel({ providerId: "cline", providerName: "Cline", upstreamId: "paid", modes: ["act"], taskId: "t", leaving })

describe("moveToAccountModel", () => {
	beforeEach(() => setup())
	it("adds what's missing, makes it the default and this chat's pick", async () => {
		const pick = await move()
		const { settings } = host.state()
		expect(settings.connections.find((c) => c.kind === "provider" && c.providerId === "cline")?.auth).toEqual({
			kind: "sdk-account",
			providerId: "cline",
		})
		expect(settings.models.find((m) => m.id === pick.modelId)?.upstreamId).toBe("paid")
		expect(settings.roles.chat).toEqual(pick)
		expect(host.callsTo("setThreadModelSelection")).toEqual([{ taskId: "t", mode: "act", pick, nextMessageOnly: false }])
	})
	it("reuses a connection and model that are already there", async () => {
		const first = await move()
		const counts = () => [host.state().settings.connections.length, host.state().settings.models.length]
		const before = counts()
		expect(await move()).toEqual(first)
		expect(counts()).toEqual(before)
	})
	it("Background text follows only from nothing or the model being left", async () => {
		const settings = gatewaySettings()
		const stay = settings.models[0].id
		settings.roles.background.pick = { modelId: stay, levelId: "default" }
		setup(settings)
		await move("other")
		expect(host.state().settings.roles.background.pick?.modelId).toBe(stay)
		const pick = await move(stay)
		expect(host.state().settings.roles.background.pick).toEqual(pick)
	})
	it("ensureAccountConnection picks nothing", async () => {
		const settings = gatewaySettings()
		settings.roles.chat = null
		setup(settings)
		const id = await ensureAccountConnection("cline-pass", "ClinePass")
		expect(await ensureAccountConnection("cline-pass", "ClinePass")).toBe(id)
		expect(host.state().settings.connections.filter((c) => c.id === id)).toHaveLength(1)
		expect(host.state().settings.roles.chat).toBeNull()
	})
})
