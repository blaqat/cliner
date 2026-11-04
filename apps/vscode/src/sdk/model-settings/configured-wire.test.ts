import { createHandler } from "@cline/llms"
import { createDefaultModelSettings, type ModelSettings } from "@shared/model-settings"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import { configuredProviderConfig } from "./runtime-config"

const transport = vi.hoisted(() => vi.fn())
vi.mock("@/shared/net", () => ({ fetch: transport }))

const high = [
	{ id: "default", label: "Default", rank: 0, request: { kind: "default" as const } },
	{ id: "low", label: "Low", rank: 1, request: { kind: "effort" as const, value: "low" } },
	{ id: "high", label: "High", rank: 2, request: { kind: "effort" as const, value: "high" } },
]

type Connection = ModelSettings["connections"][number]
function nativeConnection(providerId: string, options: Record<string, unknown> = {}): Connection {
	return {
		id: "connection",
		name: providerId,
		kind: "provider",
		providerId,
		baseUrl: "https://wire.test/v1",
		auth: { kind: "environment", variable: "WIRE_KEY" },
		headers: [],
		requestTimeoutMs: null,
		defaults: {},
		options,
		secretRefs: {},
	} as Connection
}
function compatibleConnection(auth: Connection["auth"], headers: Connection["headers"] = []): Connection {
	return {
		id: "connection",
		name: "Local",
		kind: "openai-compatible",
		apiFormat: "chat",
		baseUrl: "https://wire.test/v1",
		azureApiVersion: null,
		auth,
		headers,
		requestTimeoutMs: null,
		defaults: {},
	} as Connection
}
function settingsFor(connection: Connection, upstreamId: string, overrides: Record<string, unknown> = {}) {
	const settings = createDefaultModelSettings()
	settings.connections.push(connection)
	settings.models.push({
		id: "row",
		connectionId: connection.id,
		upstreamId,
		name: "My model",
		kind: "chat",
		overrides: { reasoning: "yes", levels: high, ...overrides },
		providerOptions: {},
	} as ModelSettings["models"][number])
	return settings
}
/** Run a real handler up to the HTTP boundary and return what it sent. */
async function capture(config: Parameters<typeof createHandler>[0]) {
	transport.mockClear()
	try {
		for await (const _chunk of createHandler(config).createMessage("System", [{ role: "user", content: "Hello" }])) {
			/* drain */
		}
	} catch {
		/* The rejection below is intentional. */
	}
	expect(transport).toHaveBeenCalled()
	const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
	return { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
}
// Not a public @cline/core export, and outside this package's rootDir, so typed by hand.
const policyModule = new URL("../../../../../sdk/packages/core/src/runtime/host/local/subagent-model-policy.ts", import.meta.url)
	.pathname
const { selectSubagentModel } = (await import(/* @vite-ignore */ policyModule)) as {
	selectSubagentModel: (input: object, policy: object, parent: object) => { error?: string; overrides?: unknown }
}
const environment = { WIRE_KEY: "fake" }
const noSecrets = () => new InMemoryConnectionSecretStore()

beforeEach(() => {
	transport.mockReset()
	transport.mockImplementation(
		async () =>
			new Response(JSON.stringify({ error: { message: "test rejection" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
	)
})

describe("native levels stay as permissive as the legacy path", () => {
	it.each([
		["anthropic", "claude-sonnet-4-5-20250929", "high", null, {}, {}],
		["anthropic", "claude-3-5-haiku-20241022", "high", null, {}, {}],
		["openai-native", "gpt-5", "default", 0.5, {}, {}],
		["openai-native", "gpt-5", "high", 0.5, {}, {}],
		["openai-native", "my-deployment", "high", null, {}, {}],
		[
			"bedrock",
			"arn:aws:bedrock:us-east-1:1:custom-model/foo",
			"high",
			null,
			{ awsAuthentication: "api-key", awsRegion: "us-east-1" },
			{ region: "us-east-1", authentication: "api-key" },
		],
	] as const)("%s %s at %s with temperature %s sends what legacy sends", async (providerId, modelId, levelId, temperature, options, aws) => {
		const settings = settingsFor(nativeConnection(providerId, options), modelId, { temperature })
		const configured = await configuredProviderConfig(
			settings,
			{ modelId: "row", levelId },
			{ secrets: noSecrets(), environment },
		)
		const sent = await capture(configured)
		const legacy = await capture({
			providerId,
			modelId,
			apiKey: "fake",
			apiKeyEnv: [],
			baseUrl: "https://wire.test/v1",
			fetch: transport as never,
			...(levelId === "default" ? {} : { reasoningEffort: levelId as "high" }),
			...(temperature === null ? {} : { temperature }),
			...(providerId === "bedrock" ? { aws } : {}),
		})
		expect(sent.url).toBe(legacy.url)
		expect(sent.body).toEqual(legacy.body)
	})

	it("sends the effort for a row marked reasoning even when the catalog doesn't list the model", async () => {
		const settings = settingsFor(nativeConnection("openai-native"), "my-deployment")
		const config = await configuredProviderConfig(
			settings,
			{ modelId: "row", levelId: "high" },
			{ secrets: noSecrets(), environment },
		)
		expect(config.reasoningEffort).toBe("high")
		expect(config.knownModels?.["my-deployment"]?.capabilities).toContain("reasoning")
	})

	it.each([
		[{ verbosity: "low" }, "verbosity"],
		[{ systemRole: "developer" }, "Developer role"],
	])("names the model and the fix on what no codec can send: %j", async (overrides, expected) => {
		const settings = settingsFor(nativeConnection("anthropic"), "claude-sonnet-4-5-20250929", overrides)
		const failure = configuredProviderConfig(
			settings,
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment },
		)
		await expect(failure).rejects.toThrow(expected)
		await expect(failure).rejects.toThrow(/^My model: .*Open Settings > Models to fix it\.$/)
	})
})

describe("keyless and identity connections", () => {
	it("sends a keyless compatible request with no credential", async () => {
		const config = await configuredProviderConfig(
			settingsFor(compatibleConnection({ kind: "none" }), "local"),
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment: {} },
		)
		const { url, headers, body } = await capture(config)
		expect(url).toBe("https://wire.test/v1/chat/completions")
		expect(headers.get("authorization")).toBeNull()
		expect(headers.get("api-key")).toBeNull()
		expect(body.model).toBe("local")
	})

	it("keeps an Authorization header the user configured on a keyless connection", async () => {
		const config = await configuredProviderConfig(
			settingsFor(
				compatibleConnection({ kind: "none" }, [
					{ id: "h", name: "Authorization", storage: "plain", value: "Bearer gateway" },
				] as Connection["headers"]),
				"local",
			),
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment: {} },
		)
		expect((await capture(config)).headers.get("authorization")).toBe("Bearer gateway")
	})

	it("sends an identity connection the way legacy does: no key and its own headers", async () => {
		const config = await configuredProviderConfig(
			settingsFor(
				compatibleConnection({ kind: "azure-identity" }, [
					{ id: "h", name: "x-gateway", storage: "plain", value: "present" },
				] as Connection["headers"]),
				"deployment",
			),
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment: {} },
		)
		const { headers } = await capture(config)
		expect(headers.get("authorization")).toBeNull()
		expect(headers.get("api-key")).toBeNull()
		expect(headers.get("x-gateway")).toBe("present")
	})
})

describe("rotated keys", () => {
	const ref = "settings:v1:connection:connection:apiKey"
	const keychain = compatibleConnection({ kind: "keychain", secretRef: ref })

	it("uses a rotated key on the next request of an already built config", async () => {
		const secrets = noSecrets()
		await secrets.set(ref, "old-key")
		const config = await configuredProviderConfig(
			settingsFor(keychain, "local"),
			{ modelId: "row", levelId: "default" },
			{ secrets, environment: {} },
		)
		expect((await capture(config)).headers.get("authorization")).toBe("Bearer old-key")
		await secrets.set(ref, "new-key")
		expect((await capture(config)).headers.get("authorization")).toBe("Bearer new-key")
	})

	it("stops sending a key that was removed, and says how to fix it", async () => {
		const secrets = noSecrets()
		await secrets.set(ref, "old-key")
		const config = await configuredProviderConfig(
			settingsFor(keychain, "local"),
			{ modelId: "row", levelId: "default" },
			{ secrets, environment: {} },
		)
		await secrets.delete(ref)
		await expect(config.fetch!("https://wire.test/v1/chat/completions", { body: "{}" })).rejects.toThrow(
			"Connection key is missing. Open Settings > Models to fix it.",
		)
		expect(transport).not.toHaveBeenCalled()
	})
})

describe("subagent levels on the wire", () => {
	const policy = (level: string, model: string, row?: Awaited<ReturnType<typeof configuredProviderConfig>>) => ({
		version: 1 as const,
		models: row
			? {
					row: {
						id: "row",
						name: "My model",
						levels: row.settingsModelLevels,
						connection: { providerId: row.providerId, modelId: row.modelId!, providerConfig: row as never },
					},
				}
			: {},
		default: { model, level },
		allowed: [],
		blocking: "parent-decides" as const,
	})
	const build = (levelId: string, connection = compatibleConnection({ kind: "none" })) =>
		configuredProviderConfig(
			settingsFor(connection, "local"),
			{ modelId: "row", levelId },
			{ secrets: noSecrets(), environment: {} },
		)
	const parentOf = (config: Awaited<ReturnType<typeof build>>) => ({
		providerId: config.providerId,
		modelId: config.modelId!,
		reasoningEffort: config.reasoningEffort,
		providerConfig: config as never,
	})
	/** The child's effective config: the parent's, then the selection's overrides. */
	async function sent(selection: ReturnType<typeof selectSubagentModel>, parent: ReturnType<typeof parentOf>) {
		expect(selection.error).toBeUndefined()
		const overrides = selection.overrides as { providerConfig?: object } | undefined
		return (await capture({ ...(overrides?.providerConfig ?? parent.providerConfig) } as never)).body
	}

	it("sends the policy default's level, not the connection's own", async () => {
		const row = await build("default")
		const parent = parentOf(await build("low"))
		const body = await sent(selectSubagentModel({}, policy("high", "row", row), parent), parent)
		expect(body.reasoning_effort).toBe("high")
	})

	it("sends no level for a subagent at default under a parent at high", async () => {
		const parent = parentOf(await build("high"))
		const body = await sent(selectSubagentModel({}, policy("default", "parent"), parent), parent)
		expect(body.reasoning_effort).toBeUndefined()
	})

	it("sends the parent's level when the subagent inherits it", async () => {
		const parent = parentOf(await build("high"))
		const body = await sent(selectSubagentModel({}, policy("inherit", "parent"), parent), parent)
		expect(body.reasoning_effort).toBe("high")
	})

	it("applies the selected level on a Responses-format connection too", async () => {
		const responses = { ...compatibleConnection({ kind: "none" }), apiFormat: "responses" } as Connection
		const row = await build("default", responses)
		const parent = parentOf(await build("low", responses))
		const body = await sent(selectSubagentModel({}, policy("high", "row", row), parent), parent)
		expect(body.reasoning).toEqual({ effort: "high" })
	})

	it("keeps the row's own request settings at the selected level", async () => {
		const row = await configuredProviderConfig(
			settingsFor(compatibleConnection({ kind: "none" }), "local", { temperature: 0.3, extraBody: { seed: 7 } }),
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment: {} },
		)
		const parent = parentOf(await build("default"))
		const body = await sent(selectSubagentModel({}, policy("low", "row", row), parent), parent)
		expect(body).toMatchObject({ reasoning_effort: "low", temperature: 0.3, seed: 7 })
	})
})
