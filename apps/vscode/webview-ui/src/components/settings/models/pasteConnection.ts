import type { ApiFormat } from "@shared/model-settings"

/** Azure's own hosts, the same list the SDK sends `api-key` to. */
const AZURE_HOSTS = [".openai.azure.com", ".cognitiveservices.azure.com", ".services.ai.azure.com"]
const KEY_HEADERS = ["authorization", "api-key", "x-api-key", "ocp-apim-subscription-key"]
const SKIPPED_HEADERS = ["content-type", "accept", "user-agent", "content-length"]
const ENDPOINT = /\/(chat\/completions|responses|completions|models|embeddings)$/
const ENV_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/

export const isAzureOpenAiHost = (url: string | null | undefined) => {
	try {
		const host = new URL(url ?? "").hostname.toLowerCase()
		return AZURE_HOSTS.some((suffix) => host.endsWith(suffix))
	} catch {
		return false
	}
}

/** What a pasted URL or curl command says about a connection. Nothing is sent to read it. */
export type PastedConnection = {
	kind: "azure" | "apim" | "openai" | "gateway"
	baseUrl: string
	/** Only when the URL names an endpoint. */
	apiFormat?: ApiFormat
	/** A version to set, null to clear one, undefined to leave it. */
	azureApiVersion?: string | null
	/** Where the key goes. Undefined leaves it. */
	keyHeader?: string | null
	key?: { value: string } | { variable: string }
	headers: { name: string; value: string }[]
	/** A deployment in the URL, or the model a curl body names. */
	model?: string
	/** More than a plain base URL: a curl command, or a URL with an endpoint, deployment or version in it. */
	rich: boolean
	/** Parts of the plain sentence saying what was read. */
	notes: string[]
}

const curlHeaders = (text: string) => {
	const found: { name: string; value: string }[] = []
	const pattern = /(?:-H|--header)\s+(?:"([^"]*)"|'([^']*)')/g
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const line = match[1] ?? match[2] ?? ""
		const at = line.indexOf(":")
		if (at > 0) {
			found.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() })
		}
	}
	return found
}

const readKey = (value: string): PastedConnection["key"] => {
	const bare = value.replace(/^Bearer\s+/i, "").trim()
	if (!bare) {
		return undefined
	}
	const reference = ENV_REF.exec(bare)
	return reference ? { variable: reference[1] } : { value: bare }
}

/**
 * Reads a pasted endpoint URL (Azure, API Management, a gateway, api.openai.com) or a curl command into the
 * connection fields it names. A problem says why it can't be read; undefined is text that isn't a paste.
 */
export function readPastedConnection(text: string): PastedConnection | { problem: string } | undefined {
	const raw = text.trim()
	if (!raw) {
		return undefined
	}
	if (/^(sk-[\w-]{10,}|[a-f0-9]{32,})$/i.test(raw)) {
		return { problem: "That looks like a key. Paste it in API key below." }
	}
	const found = raw.match(/https?:\/\/[^\s"'<>\\]+/)
	if (!found) {
		return undefined
	}
	let url: URL
	try {
		url = new URL(found[0])
	} catch {
		return undefined
	}
	const curl = /^curl\b/i.test(raw) || raw !== found[0]
	const host = url.hostname.toLowerCase()
	const path = url.pathname.replace(/\/+$/, "")
	const version = url.searchParams.get("api-version") ?? undefined
	const notes: string[] = []
	const pasted: PastedConnection = { kind: "gateway", baseUrl: "", headers: [], rich: curl, notes }

	const endpoint = ENDPOINT.exec(path)?.[1]
	if (endpoint === "responses") {
		pasted.apiFormat = "responses"
	} else if (endpoint === "chat/completions") {
		pasted.apiFormat = "chat"
	}
	const deployment = /^(.*?)\/openai\/deployments\/([^/]+)/.exec(path)
	if (deployment) {
		pasted.model = decodeURIComponent(deployment[2])
	}
	const openAiPrefix = /^(.*?)\/openai(\/v1)?(?:\/|$)/.exec(path)
	pasted.rich ||= !!endpoint || !!deployment || !!version

	if (AZURE_HOSTS.some((suffix) => host.endsWith(suffix))) {
		// One base for every deployment; the v1 path serves Chat and Responses with no version to keep current.
		pasted.kind = "azure"
		pasted.baseUrl = `${url.origin}/openai/v1`
		pasted.azureApiVersion = null
		pasted.keyHeader = "api-key"
		notes.push(`Azure OpenAI (${host.split(".")[0]})`)
		notes.push(version ? `the v1 path, which needs no API version (yours was ${version})` : "the v1 path, no API version")
	} else if (host.endsWith(".azure-api.net")) {
		pasted.kind = "apim"
		pasted.keyHeader = "Ocp-Apim-Subscription-Key"
		notes.push("Azure API Management")
		if (openAiPrefix) {
			const v1 = !!openAiPrefix[2]
			pasted.baseUrl = `${url.origin}${openAiPrefix[1]}/openai${v1 ? "/v1" : ""}`
			pasted.azureApiVersion = v1 ? null : version
			if (v1) {
				notes.push("no API version")
			} else if (version) {
				notes.push(`API version ${version}`)
			}
		} else {
			pasted.baseUrl = `${url.origin}${path.replace(ENDPOINT, "")}`
			if (version) {
				pasted.azureApiVersion = version
				notes.push(`API version ${version}`)
			}
		}
	} else if (host === "api.openai.com") {
		pasted.kind = "openai"
		pasted.baseUrl = "https://api.openai.com/v1"
		notes.push("OpenAI")
	} else {
		notes.push(`a gateway at ${url.host}`)
		pasted.baseUrl = deployment ? `${url.origin}${deployment[1]}/openai` : `${url.origin}${path.replace(ENDPOINT, "")}`
		if (version) {
			pasted.azureApiVersion = version
			notes.push(`API version ${version}`)
		}
	}
	if (deployment) {
		notes.push("the base URL split from the deployment URL")
	}
	if (pasted.apiFormat) {
		notes.push(pasted.apiFormat === "responses" ? "Responses" : "Chat")
	}

	for (const header of curl ? curlHeaders(raw) : []) {
		const lower = header.name.toLowerCase()
		if (SKIPPED_HEADERS.includes(lower)) {
			continue
		}
		if (KEY_HEADERS.includes(lower)) {
			pasted.key = readKey(header.value) ?? pasted.key
			// Bearer is what a connection sends with no key header; Azure's own hosts get api-key either way.
			pasted.keyHeader = lower === "authorization" ? (pasted.kind === "azure" ? "api-key" : null) : header.name
			continue
		}
		pasted.headers.push({ name: header.name, value: ENV_REF.test(header.value) ? "" : header.value })
	}
	const key = pasted.key && ("variable" in pasted.key ? `the key from $${pasted.key.variable}` : "your key")
	if (key || pasted.keyHeader) {
		notes.push(pasted.keyHeader ? `${key ?? "the key"}, sent in ${pasted.keyHeader}` : key!)
	}
	for (const header of pasted.headers) {
		notes.push(header.value ? `header ${header.name}` : `header ${header.name} (type its value)`)
	}
	const named = raw.match(/"model"\s*:\s*"([^"]+)"/)?.[1]
	pasted.model ??= named
	if (pasted.model) {
		notes.push(`${pasted.model} as its first model`)
	}
	return pasted
}
