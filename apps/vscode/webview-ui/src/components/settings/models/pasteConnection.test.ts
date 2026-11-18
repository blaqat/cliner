import { describe, expect, it } from "vitest"
import { isAzureOpenAiHost, readPastedConnection } from "./pasteConnection"

/** Not a key. A constant, so secret scanners don't read the curl line below as one. */
const FAKE_KEY = "fake-openai-key"

const read = (text: string) => {
	const pasted = readPastedConnection(text)
	if (!pasted || "problem" in pasted) {
		throw new Error(`expected a reading of ${text}`)
	}
	return pasted
}

describe("reading a pasted URL or curl command", () => {
	it("splits an Azure deployment URL into the resource on the v1 path and the deployment as a model", () => {
		expect(
			read(
				"https://contoso-ai.cognitiveservices.azure.com/openai/deployments/gpt-41-prod/chat/completions?api-version=2025-01-01-preview",
			),
		).toMatchObject({
			kind: "azure",
			baseUrl: "https://contoso-ai.cognitiveservices.azure.com/openai/v1",
			azureApiVersion: null,
			keyHeader: "api-key",
			apiFormat: "chat",
			model: "gpt-41-prod",
			rich: true,
		})
	})

	it("reads an Azure curl: Responses, the key from an env var, the model from the body", () => {
		const pasted = read(`curl -X POST "https://contoso.openai.azure.com/openai/responses?api-version=2025-04-01-preview" \\
  -H "Content-Type: application/json" \\
  -H "api-key: $AZURE_API_KEY" \\
  -d '{"model": "o4-mini-eu", "input": "Hello"}'`)
		expect(pasted).toMatchObject({
			kind: "azure",
			baseUrl: "https://contoso.openai.azure.com/openai/v1",
			apiFormat: "responses",
			key: { variable: "AZURE_API_KEY" },
			keyHeader: "api-key",
			model: "o4-mini-eu",
			headers: [],
		})
		expect(pasted.notes.join(" ")).toContain("yours was 2025-04-01-preview")
		expect(pasted.notes).toContain("the key from $AZURE_API_KEY, sent in api-key")
	})

	it("reads an API Management curl: base, version, the subscription key and its header", () => {
		expect(
			read(`curl "https://acme-ai.azure-api.net/openai-gw/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21" \\
  -H "Ocp-Apim-Subscription-Key: fake-apim-key" \\
  -d '{"messages": [{"role": "user", "content": "hi"}]}'`),
		).toMatchObject({
			kind: "apim",
			baseUrl: "https://acme-ai.azure-api.net/openai-gw/openai",
			azureApiVersion: "2024-10-21",
			keyHeader: "Ocp-Apim-Subscription-Key",
			key: { value: "fake-apim-key" },
			model: "gpt-4o",
		})
	})

	it("keeps the header an API Management gateway imported from Azure uses", () => {
		expect(read(`curl https://acme.azure-api.net/team/openai/v1/chat/completions -H "api-key: abc"`)).toMatchObject({
			baseUrl: "https://acme.azure-api.net/team/openai/v1",
			azureApiVersion: null,
			keyHeader: "api-key",
		})
	})

	it("sends an API Management key in its subscription header when the URL alone is pasted", () => {
		expect(read("https://acme.azure-api.net/team/openai")).toMatchObject({
			kind: "apim",
			baseUrl: "https://acme.azure-api.net/team/openai",
			keyHeader: "Ocp-Apim-Subscription-Key",
			rich: false,
		})
	})

	it("reads a gateway curl: Bearer stays the default, other headers come along", () => {
		const pasted = read(`curl https://llm.acme.internal/v1/responses \\
  -H "Authorization: Bearer $ACME_LLM_KEY" \\
  -H "X-Team: payments" \\
  -H "X-Trace: $TRACE" \\
  -d '{"model": "claude-sonnet-4-5", "input": "hi"}'`)
		expect(pasted).toMatchObject({
			kind: "gateway",
			baseUrl: "https://llm.acme.internal/v1",
			apiFormat: "responses",
			key: { variable: "ACME_LLM_KEY" },
			keyHeader: null,
			model: "claude-sonnet-4-5",
			headers: [
				{ name: "X-Team", value: "payments" },
				{ name: "X-Trace", value: "" },
			],
		})
		expect(pasted.notes).toContain("header X-Trace (type its value)")
	})

	it("treats a company gateway in front of Azure like one, keeping its version", () => {
		expect(
			read("https://ai.corp.example/azure/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21"),
		).toMatchObject({
			kind: "gateway",
			baseUrl: "https://ai.corp.example/azure/openai",
			azureApiVersion: "2024-10-21",
			model: "gpt-4o",
		})
	})

	it("reads api.openai.com and a key someone pasted with it", () => {
		expect(read(`curl https://api.openai.com/v1/chat/completions -H "Authorization: Bearer ${FAKE_KEY}"`)).toMatchObject({
			kind: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiFormat: "chat",
			key: { value: FAKE_KEY },
		})
	})

	it("leaves a plain base URL alone and says a key isn't a URL", () => {
		expect(read("https://gw.example/v1")).toMatchObject({ kind: "gateway", baseUrl: "https://gw.example/v1", rich: false })
		expect(readPastedConnection("sk-abcdefghijklmnop")).toEqual({
			problem: "That looks like a key. Paste it in API key below.",
		})
		expect(readPastedConnection("not a url")).toBeUndefined()
	})

	it("knows Azure's own hosts the way the SDK does", () => {
		expect(isAzureOpenAiHost("https://r.openai.azure.com/openai/v1")).toBe(true)
		expect(isAzureOpenAiHost("https://r.services.ai.azure.com")).toBe(true)
		expect(isAzureOpenAiHost("https://acme.azure-api.net/openai")).toBe(false)
		expect(isAzureOpenAiHost(null)).toBe(false)
	})
})
