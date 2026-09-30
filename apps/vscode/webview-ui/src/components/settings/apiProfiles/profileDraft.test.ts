import { ApiConfigProfile } from "@shared/proto/cline/models"
import { OPENAI_REASONING_EFFORT_OPTIONS } from "@shared/storage/types"
import { describe, expect, it } from "vitest"
import {
	buildSaveRequest,
	changeDraftProvider,
	describeProfile,
	draftFromProto,
	duplicateDraft,
	getDraftModelInfo,
	newProfileDraft,
	setDraftHeaders,
	setDraftModelInfo,
	setDraftOption,
	setDraftSecret,
} from "./profileDraft"

describe("profileDraft", () => {
	it("saves custom headers, Azure settings and model info, dropping unnamed headers", () => {
		let draft = { ...newProfileDraft("openai"), name: "Proxy", modelId: "m" }
		draft = setDraftHeaders(draft, { "X-Team": "core", " ": "ignored", " X-Trace ": "1" })
		draft = setDraftOption(draft, "azureApiVersion", "2025-01-01")
		draft = setDraftOption(draft, "azureIdentity", true)
		draft = setDraftModelInfo(draft, { contextWindow: 64_000, temperature: 0.2 })
		const options = JSON.parse(buildSaveRequest(draft).optionsJson)
		expect(options.openAiHeaders).toEqual({ "X-Team": "core", "X-Trace": "1" })
		expect(options.azureApiVersion).toBe("2025-01-01")
		expect(options.azureIdentity).toBe(true)
		expect(options.planModeOpenAiModelInfo).toMatchObject({ contextWindow: 64_000, temperature: 0.2 })
	})

	it("edits model info captured under either mode prefix into a single copy", () => {
		const draft = setDraftOption(newProfileDraft("openai"), "actModeOpenAiModelInfo", {
			contextWindow: 8_000,
			maxTokens: 512,
		})
		expect(getDraftModelInfo(draft)?.contextWindow).toBe(8_000)
		const edited = setDraftModelInfo(draft, { maxTokens: 1_024 })
		expect(edited.options.actModeOpenAiModelInfo).toBeUndefined()
		expect(edited.options.planModeOpenAiModelInfo).toMatchObject({ contextWindow: 8_000, maxTokens: 1_024 })
	})

	it("splits options and secrets, omitting blank secrets", () => {
		let draft = {
			...newProfileDraft("openai"),
			name: " Local ",
			modelId: "gpt-x",
			openAiCompatibleApiType: "responses" as const,
		}
		draft = setDraftOption(draft, "openAiBaseUrl", "http://localhost:1234/v1")
		draft = setDraftOption(draft, "openAiHeaders", "")
		draft = setDraftSecret(draft, "openAiApiKey", "")
		const request = buildSaveRequest(draft)
		expect(request.name).toBe("Local")
		expect(request.openAiCompatibleApiType).toBe("responses")
		expect(JSON.parse(request.optionsJson)).toEqual({ openAiBaseUrl: "http://localhost:1234/v1" })
		expect(request.secrets).toEqual({})
		expect(request.id).toBe("")

		const withKey = buildSaveRequest(setDraftSecret(draft, "openAiApiKey", "sk-1"))
		expect(withKey.secrets).toEqual({ openAiApiKey: "sk-1" })
	})

	it("loads a stored profile and keeps untouched options on save", () => {
		const draft = draftFromProto(
			ApiConfigProfile.create({
				id: "p1",
				name: "Claude",
				provider: "anthropic",
				modelId: "m",
				optionsJson: JSON.stringify({ anthropicBaseUrl: "https://x" }),
				secretKeys: ["apiKey"],
			}),
		)
		const request = buildSaveRequest(draft)
		expect(request.id).toBe("p1")
		expect(JSON.parse(request.optionsJson)).toEqual({ anthropicBaseUrl: "https://x" })
		expect(request.secrets).toEqual({})
		expect(request.openAiCompatibleApiType).toBe("")
	})

	it("resets provider-specific state when the provider changes", () => {
		const draft = setDraftSecret(
			setDraftOption({ ...newProfileDraft("openai"), modelId: "m" }, "openAiBaseUrl", "u"),
			"openAiApiKey",
			"k",
		)
		const next = changeDraftProvider(draft, "anthropic")
		expect(next).toMatchObject({ provider: "anthropic", modelId: "", options: {}, secrets: {} })
	})

	it("duplicates as an unsaved copy", () => {
		const copy = duplicateDraft({ ...newProfileDraft("anthropic"), id: "p1", name: "A", savedSecretKeys: ["apiKey"] })
		expect(copy).toMatchObject({ id: undefined, name: "A copy", savedSecretKeys: [] })
	})

	it("describes profiles with API type for OpenAI Compatible", () => {
		expect(describeProfile({ provider: "openai", modelId: "m", openAiCompatibleApiType: "responses" })).toBe(
			"OpenAI Compatible · m · Responses",
		)
		expect(describeProfile({ provider: "anthropic", modelId: "c" })).toBe("Anthropic · c")
	})
})

describe("profile default effort drafts", () => {
	it.each(OPENAI_REASONING_EFFORT_OPTIONS)("round trips %s through editing and duplication", (reasoningEffort) => {
		const draft = draftFromProto(ApiConfigProfile.create({ id: "a", provider: "anthropic", reasoningEffort }))
		expect(draft.reasoningEffort).toBe(reasoningEffort)
		expect(buildSaveRequest(draft).reasoningEffort).toBe(reasoningEffort)
		expect(buildSaveRequest(duplicateDraft(draft)).reasoningEffort).toBe(reasoningEffort)
		expect(changeDraftProvider(draft, "openai").reasoningEffort).toBe(reasoningEffort)
	})

	it("uses provider default for new, old and invalid profiles", () => {
		expect(newProfileDraft().reasoningEffort).toBe("none")
		for (const reasoningEffort of ["", "invalid"]) {
			expect(draftFromProto(ApiConfigProfile.create({ reasoningEffort })).reasoningEffort).toBe("none")
		}
	})
})
