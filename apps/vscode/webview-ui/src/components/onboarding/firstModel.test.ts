import { describe, expect, it } from "vitest"
import { newProfileDraft, type ProfileDraft } from "../settings/apiProfiles/profileDraft"
import { firstModelFromDraft } from "./firstModel"

const ids = { connectionId: "c", modelId: "m" }
const draft = (change: Partial<ProfileDraft>): ProfileDraft => ({
	...newProfileDraft(),
	name: "First",
	modelId: "model-1",
	...change,
})

describe("firstModelFromDraft", () => {
	it("makes an OpenAI-compatible connection from the form", () => {
		const { connection, secrets, model, levelId } = firstModelFromDraft(
			draft({
				provider: "openai",
				openAiCompatibleApiType: "responses",
				options: {
					openAiBaseUrl: " http://x/v1 ",
					openAiHeaders: { "X-Team": "a", "": "dropped" },
					azureApiVersion: "2024-01",
					planModeOpenAiModelInfo: { contextWindow: 32000, maxTokens: 4000, inputPrice: 1, supportsImages: false },
				},
				secrets: { openAiApiKey: "sk-1" },
			}),
			ids,
		)
		expect(connection).toMatchObject({
			id: "c",
			kind: "openai-compatible",
			baseUrl: "http://x/v1",
			apiFormat: "responses",
			azureApiVersion: "2024-01",
			auth: { kind: "keychain", secretRef: "settings:v1:connection:c:apiKey" },
			headers: [expect.objectContaining({ name: "X-Team", storage: "plain", value: "a" })],
		})
		expect(secrets).toEqual([{ field: "apiKey", operation: "set", value: "sk-1" }])
		expect(model).toMatchObject({
			id: "m",
			connectionId: "c",
			upstreamId: "model-1",
			overrides: { contextWindow: 32000, maxOutputTokens: 4000, inputPrice: 1, images: "no" },
		})
		expect(levelId).toBe("default")
	})
	it("Azure identity keeps no key", () => {
		const { connection, secrets } = firstModelFromDraft(
			draft({
				provider: "openai",
				options: { openAiBaseUrl: "http://x", azureIdentity: true },
				secrets: { openAiApiKey: "unused" },
			}),
			ids,
		)
		expect(connection.auth).toEqual({ kind: "azure-identity" })
		expect(secrets).toEqual([])
	})
	it("offers a compatible model the level it was given", () => {
		const high = firstModelFromDraft(
			draft({ provider: "openai", options: { openAiBaseUrl: "http://x" }, reasoningEffort: "high" }),
			ids,
		)
		expect(high.levelId).toBe("high")
		expect(high.model.overrides.reasoning).toBe("yes")
		expect(high.model.overrides.levels?.map((level) => level.id)).toContain("high")
		const xhigh = firstModelFromDraft(
			draft({ provider: "openai", options: { openAiBaseUrl: "http://x" }, reasoningEffort: "xhigh" }),
			ids,
		)
		expect(xhigh.model.overrides.levels?.map((level) => level.id)).toContain("xhigh")
	})
	it.each(["anthropic", "openai-native"] as const)("%s keeps its key on the connection", (provider) => {
		const field = provider === "anthropic" ? "apiKey" : "openAiNativeApiKey"
		const { connection, secrets } = firstModelFromDraft(
			draft({
				provider,
				options: provider === "anthropic" ? { anthropicBaseUrl: "http://a" } : {},
				secrets: { [field]: "sk-2" },
			}),
			ids,
		)
		expect(connection).toMatchObject({
			kind: "provider",
			providerId: provider,
			baseUrl: provider === "anthropic" ? "http://a" : null,
			auth: { kind: "keychain", secretRef: "settings:v1:connection:c:apiKey" },
		})
		expect(secrets).toEqual([{ field: "apiKey", operation: "set", value: "sk-2" }])
	})
	it("Bedrock splits connection and model options and stores each credential", () => {
		const { connection, secrets, model } = firstModelFromDraft(
			draft({
				provider: "bedrock",
				options: { awsRegion: "us-east-1", awsAuthentication: "credentials", awsUseCrossRegionInference: true },
				secrets: { awsAccessKey: "id", awsSecretKey: "secret" },
			}),
			ids,
		)
		expect(connection).toMatchObject({
			auth: { kind: "none" },
			options: { awsRegion: "us-east-1", awsAuthentication: "credentials" },
			secretRefs: {
				awsAccessKey: "settings:v1:connection:c:awsAccessKey",
				awsSecretKey: "settings:v1:connection:c:awsSecretKey",
			},
		})
		expect(secrets).toEqual([
			{ field: "awsAccessKey", operation: "set", value: "id" },
			{ field: "awsSecretKey", operation: "set", value: "secret" },
		])
		expect(model.providerOptions).toEqual({ awsUseCrossRegionInference: true })
	})
})
