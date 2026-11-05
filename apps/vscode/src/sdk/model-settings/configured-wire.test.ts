import { createHandler, supportsModelTool } from "@cline/llms"
import { modelSupportsImageInput, modelSupportsToolCalling } from "@cline/shared"
import { createDefaultModelSettings, type ModelSettings, ModelSettingsSchema } from "@shared/model-settings"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildSubagentModelSettings } from "../subagent-profiles"
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
/** The same, with tools offered and an image in the message. */
async function captureWithTools(config: Parameters<typeof createHandler>[0]) {
	transport.mockClear()
	const tool = { name: "read_file", description: "Read", inputSchema: { type: "object", properties: {} } }
	const image = { type: "image", mediaType: "image/png", data: "AAAA" } as never
	const text = { type: "text", text: "Hello" } as never
	try {
		for await (const _chunk of createHandler(config).createMessage("System", [{ role: "user", content: [text, image] }], [
			tool,
		] as never)) {
			/* drain */
		}
	} catch {
		/* The rejection below is intentional. */
	}
	expect(transport).toHaveBeenCalled()
	const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
	return JSON.parse(String(init.body))
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

describe("Azure API version", () => {
	const configFor = (
		baseUrl: string,
		apiFormat: "chat" | "responses",
		azureApiVersion: string | null = "2025-01-01-preview",
	) => {
		const connection = {
			...compatibleConnection({ kind: "none" }),
			baseUrl,
			apiFormat,
			azureApiVersion,
		} as Connection
		return configuredProviderConfig(
			settingsFor(connection, "gpt"),
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment },
		)
	}
	it("Responses stays this provider, so OpenAI's built-in tools aren't added to a gateway's requests", async () => {
		const config = await configFor("https://gw.test/team/openai/deployments/gpt", "responses")
		expect(config).toMatchObject({ providerId: "openai-compatible", routingProviderId: "openai-native" })
		for (const tool of ["image_generation", "web_search"] as const)
			expect(supportsModelTool({ providerId: config.providerId, modelId: "gpt-6-sol" }, tool), tool).toBe(false)
		const { url, body } = await capture(config)
		expect(new URL(url).pathname).toBe("/team/openai/responses")
		expect(body.model).toBe("gpt")
	})
	it.each([
		["https://gw.test/team/openai", "/team/openai/deployments/gpt/chat/completions"],
		["https://r.openai.azure.com/openai", "/openai/deployments/gpt/chat/completions"],
		["https://r.openai.azure.com", "/openai/deployments/gpt/chat/completions"],
		["https://gw.test/team/openai/deployments/fixed", "/team/openai/deployments/fixed/chat/completions"],
		["https://gw.test/v1", "/v1/chat/completions"],
	])("adding models to %s posts chat to %s", async (base, path) => {
		const { url } = await capture(await configFor(base, "chat"))
		expect(new URL(url).pathname).toBe(path)
	})
	it("a bare Azure base with no version uses the versionless API", async () => {
		const { url } = await capture(await configFor("https://r.openai.azure.com/openai", "chat", null))
		expect(new URL(url).pathname).toBe("/openai/v1/chat/completions")
	})
	it("sends a key as api-key to an Azure host", async () => {
		const connection = {
			...compatibleConnection({ kind: "keychain", secretRef: "settings:v1:connection:connection:apiKey" }),
			baseUrl: "https://r.openai.azure.com/openai",
			azureApiVersion: "2025-01-01-preview",
		} as Connection
		const secrets = noSecrets()
		await secrets.set("settings:v1:connection:connection:apiKey", "azure-key")
		const config = await configuredProviderConfig(
			settingsFor(connection, "gpt"),
			{ modelId: "row", levelId: "default" },
			{ secrets, environment },
		)
		const { headers } = await capture(config)
		expect(headers.get("api-key")).toBe("azure-key")
	})
	const formats = ["chat", "responses"] as const
	const bases = [
		"https://r.openai.azure.com/openai/deployments/gpt",
		"https://r.openai.azure.com/openai",
		"https://r.openai.azure.com",
		"https://gw.azure-api.net/team/openai/deployments/gpt",
		"https://r.services.ai.azure.com/models",
		"https://gateway.test/v1",
	]
	for (const apiFormat of formats) {
		for (const base of bases) {
			it(`goes in the query string of a ${apiFormat} POST to ${base}`, async () => {
				const { url } = await capture(await configFor(base, apiFormat))
				expect(new URL(url).searchParams.get("api-version")).toBe("2025-01-01-preview")
			})
		}
		it(`stays off a ${apiFormat} POST to /openai/v1, which refuses it`, async () => {
			const { url } = await capture(await configFor("https://r.openai.azure.com/openai/v1", apiFormat))
			expect(new URL(url).searchParams.has("api-version")).toBe(false)
		})
		it(`isn't sent on ${apiFormat} when left blank`, async () => {
			const { url } = await capture(await configFor("https://gateway.test/v1", apiFormat, null))
			expect(new URL(url).searchParams.has("api-version")).toBe(false)
		})
	}
})

describe("OpenAI's built-in tools", () => {
	it.each([
		["https://acme-foundry-api.azure-api.net/openai", false],
		["https://acme.openai.azure.com/openai/deployments/x", false],
		["https://gateway.test/v1", false],
		["not a url", false],
		["https://api.openai.com/v1", true],
		[undefined, true],
	])("on openai-native at %s: %s", (baseUrl, offered) => {
		for (const tool of ["image_generation", "web_search"] as const)
			expect(supportsModelTool({ providerId: "openai-native", modelId: "gpt-5", baseUrl }, tool), tool).toBe(offered)
	})
})

describe("tools and images a catalog doesn't know", () => {
	const build = (overrides: Record<string, unknown>) =>
		configuredProviderConfig(
			settingsFor(compatibleConnection({ kind: "none" }), "unlisted-model", {
				reasoning: "no",
				levels: undefined,
				...overrides,
			}),
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment },
		)
	it.each([
		[{}, false, false],
		[{ tools: "unknown", images: "unknown" }, false, false],
		[{ reasoning: "yes" }, false, false],
		[{ tools: "yes" }, true, false],
		[{ images: "yes" }, false, true],
		[{ tools: "yes", images: "yes" }, true, true],
	])("with %j, tools %s and images %s", async (overrides, tools, images) => {
		const config = await build(overrides)
		const info = config.knownModels!["unlisted-model"]
		expect(modelSupportsToolCalling(info)).toBe(tools)
		expect(modelSupportsImageInput(info)).toBe(images)
		const body = await captureWithTools(config)
		expect(body.tools?.length ?? 0).toBe(tools ? 1 : 0)
	})
})

describe("temperature", () => {
	const send = async (apiFormat: "chat" | "responses", overrides: Record<string, unknown>, defaults: object = {}) => {
		const connection = { ...compatibleConnection({ kind: "none" }), apiFormat, defaults } as Connection
		return capture(
			await configuredProviderConfig(
				settingsFor(connection, "gpt-6-sol", overrides),
				{ modelId: "row", levelId: "default" },
				{ secrets: noSecrets(), environment },
			),
		)
	}
	for (const apiFormat of ["chat", "responses"] as const) {
		it(`blank sends no temperature on ${apiFormat}`, async () => {
			expect((await send(apiFormat, {})).body).not.toHaveProperty("temperature")
		})
		it(`a blank shared default sends none on ${apiFormat}`, async () => {
			expect((await send(apiFormat, {}, { temperature: null })).body).not.toHaveProperty("temperature")
		})
		it.each([0, 1, 0.7])(`%s is sent as typed on ${apiFormat}`, async (temperature) => {
			expect((await send(apiFormat, { temperature })).body.temperature).toBe(temperature)
		})
		it(`a shared default of 0 is sent on ${apiFormat} when the model leaves it blank`, async () => {
			expect((await send(apiFormat, {}, { temperature: 0 })).body.temperature).toBe(0)
		})
	}
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

describe("Tools and Images answers reach the request", () => {
	const build = (overrides: Record<string, unknown>) =>
		configuredProviderConfig(
			settingsFor(compatibleConnection({ kind: "none" }), "local", {
				reasoning: "unknown",
				levels: undefined,
				...overrides,
			}),
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment: {} },
		)
	const session = (config: Awaited<ReturnType<typeof build>>) => config.knownModels![config.modelId!]
	const hasImage = (body: { messages: Array<{ content: unknown }> }) => JSON.stringify(body.messages).includes("image_url")

	it.each([
		["no", false],
		["unknown", false],
		["yes", true],
	])("Tools=%s alone: tools sent is %s, at both the session gate and the wire", async (tools, sends) => {
		const config = await build({ tools })
		// The gate the session runtime uses to build its tool list.
		expect(modelSupportsToolCalling(session(config))).toBe(sends)
		const body = await captureWithTools(config)
		expect(Array.isArray(body.tools) && body.tools.length > 0).toBe(sends)
	})

	it.each([
		["no", false],
		["unknown", false],
		["yes", true],
	])("Images=%s with Tools=yes: images sent is %s, and tools stay", async (images, sends) => {
		const config = await build({ images, tools: "yes" })
		expect(modelSupportsImageInput(session(config))).toBe(sends)
		const body = await captureWithTools(config)
		expect(hasImage(body)).toBe(sends)
		expect(body.tools?.length).toBeGreaterThan(0)
	})

	it("Tools=No and Images=No together say no to both", async () => {
		const config = await build({ tools: "no", images: "no" })
		expect(modelSupportsToolCalling(session(config))).toBe(false)
		expect(modelSupportsImageInput(session(config))).toBe(false)
		const body = await captureWithTools(config)
		expect(body.tools ?? []).toEqual([])
		expect(hasImage(body)).toBe(false)
	})

	it("a catalog model set to Tools=No keeps what the catalog says about images", async () => {
		const settings = settingsFor(nativeConnection("openai-native"), "gpt-5", {
			tools: "no",
			reasoning: "unknown",
			levels: undefined,
		})
		const config = await configuredProviderConfig(
			settings,
			{ modelId: "row", levelId: "default" },
			{ secrets: noSecrets(), environment },
		)
		expect(modelSupportsToolCalling(config.knownModels![config.modelId!])).toBe(false)
		expect(modelSupportsImageInput(config.knownModels![config.modelId!])).toBe(true)
	})
})

describe("a migrated Default-only row", () => {
	it("sends no effort and no thinking setting, on either API", async () => {
		for (const apiFormat of ["chat", "responses"]) {
			const settings = settingsFor(compatibleConnection({ kind: "none" }), "local", {
				reasoning: undefined,
				levels: undefined,
			})
			;(settings.connections[0] as { apiFormat: string }).apiFormat = apiFormat
			const body = (
				await capture(
					await configuredProviderConfig(
						settings,
						{ modelId: "row", levelId: "default" },
						{ secrets: noSecrets(), environment: {} },
					),
				)
			).body
			expect(body).not.toHaveProperty("reasoning_effort")
			expect(body).not.toHaveProperty("reasoning")
		}
	})
})

describe('"Same as the thread" on the allowed list', () => {
	const noKey = compatibleConnection({ kind: "none" })
	const parentFor = async (levelId: string) => {
		const config = await configuredProviderConfig(
			settingsFor(noKey, "local"),
			{ modelId: "row", levelId },
			{ secrets: noSecrets(), environment: {} },
		)
		return {
			providerId: config.providerId,
			modelId: config.modelId!,
			reasoningEffort: config.reasoningEffort,
			providerConfig: config as never,
		}
	}
	const policyFor = async (levels: string[]) => {
		const settings = settingsFor(noKey, "local")
		settings.roles.subagents = { kind: "model", pick: { modelId: "row", levelId: "low" } }
		// What the picker writes when "Same as the thread" is chosen.
		settings.subagents.allowed = [{ kind: "thread", levels }]
		expect(() => ModelSettingsSchema.parse(settings)).not.toThrow()
		return (
			await buildSubagentModelSettings(settings, async () => ({
				connection: { providerId: "openai-compatible", modelId: "local" } as never,
				levels: high as never,
			}))
		).modelPolicy!
	}
	const childBody = async (selection: { overrides?: unknown }, parent: Awaited<ReturnType<typeof parentFor>>) => {
		const overrides = selection.overrides as { providerConfig?: object } | undefined
		return (await capture({ ...(overrides?.providerConfig ?? parent.providerConfig) } as never)).body
	}

	it("becomes the parent entry, and the parent can spawn on it at the thread's own level", async () => {
		const policy = await policyFor(["inherit"])
		expect(policy.allowed).toEqual([{ model: "parent", levels: ["inherit"] }])
		const parent = await parentFor("high")
		const selection = selectSubagentModel({ model: "parent" }, policy, parent)
		expect(selection.error).toBeUndefined()
		expect((await childBody(selection, parent)).reasoning_effort).toBe("high")
	})

	it("at a fixed level, sends that level on the thread's model", async () => {
		const parent = await parentFor("high")
		const selection = selectSubagentModel({ model: "parent" }, await policyFor(["low"]), parent)
		expect(selection.error).toBeUndefined()
		const body = await childBody(selection, parent)
		expect(body.model).toBe("local")
		expect(body.reasoning_effort).toBe("low")
	})

	it("refuses a level off the list, naming what's allowed", async () => {
		const parent = await parentFor("high")
		const selection = selectSubagentModel({ model: "parent", reasoningEffort: "high" }, await policyFor(["low"]), parent)
		expect(selection.error).toContain("Allowed: low")
	})
})
