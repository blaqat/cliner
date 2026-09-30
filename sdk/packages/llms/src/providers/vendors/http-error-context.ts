type FetchWithOptionalPreconnect = typeof fetch & {
	preconnect?: (...args: unknown[]) => unknown;
};

function describeRequest(
	input: Parameters<typeof fetch>[0],
	init: RequestInit | undefined,
): string {
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	try {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		// Query strings can carry credentials; the path is what identifies a
		// wrong endpoint.
		return `${method} ${url.origin}${url.pathname}`;
	} catch {
		return method;
	}
}

/**
 * Append the HTTP status and endpoint to provider error messages. Endpoint
 * errors such as Azure's bare "Resource not found" are otherwise impossible
 * to tell apart from model errors.
 */
export function withHttpErrorContext(
	baseFetch: typeof fetch | undefined,
): typeof fetch {
	const target = baseFetch ?? globalThis.fetch;
	const wrapped = (async (input, init) => {
		const response = await target(input, init);
		if (response.ok) {
			return response;
		}
		const suffix = ` (HTTP ${response.status} from ${describeRequest(input, init)})`;
		const text = await response.text();
		let body = text;
		try {
			const payload = JSON.parse(text) as unknown;
			const error =
				payload && typeof payload === "object"
					? (payload as { error?: unknown }).error
					: undefined;
			if (error && typeof error === "object") {
				const record = error as { message?: unknown };
				record.message = `${typeof record.message === "string" ? record.message : "Request failed"}${suffix}`;
				body = JSON.stringify(payload);
			} else if (typeof error === "string") {
				body = JSON.stringify({ ...(payload as object), error: `${error}${suffix}` });
			}
		} catch {
			body = `${text || response.statusText || "Request failed"}${suffix}`;
		}
		const headers = new Headers(response.headers);
		headers.delete("content-encoding");
		headers.delete("content-length");
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}) as typeof fetch;
	const withPreconnect = target as FetchWithOptionalPreconnect;
	(wrapped as FetchWithOptionalPreconnect).preconnect =
		typeof withPreconnect.preconnect === "function"
			? withPreconnect.preconnect.bind(target)
			: () => undefined;
	return wrapped;
}

const AZURE_OPENAI_HOST_SUFFIXES = [
	".openai.azure.com",
	".cognitiveservices.azure.com",
	".services.ai.azure.com",
];

export interface AzureResponsesEndpoint {
	baseUrl: string;
	/** Deployment named in a deployment-style base URL, used as the model. */
	deployment?: string;
	/** Appended as `api-version` to requests under `baseUrl`. */
	apiVersion?: string;
}

/**
 * Azure OpenAI (directly or behind a gateway such as API Management) serves
 * Chat Completions under `<prefix>/openai/deployments/<name>`, but the
 * Responses API at `<prefix>/openai/responses?api-version=...` with the
 * deployment passed as the model, or at `<prefix>/openai/v1/responses`
 * without an API version. Maps a deployment-style base URL (any host) or a
 * bare Azure OpenAI host to the Responses base. Returns undefined when the
 * base URL needs no rewrite (e.g. api.openai.com or an explicit /openai/v1).
 */
export function resolveAzureResponsesEndpoint(
	baseUrl: string | undefined,
	apiVersion?: string,
): AzureResponsesEndpoint | undefined {
	if (!baseUrl) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return undefined;
	}
	const path = url.pathname.replace(/\/+$/, "");
	const match = /^(.*?)\/openai\/deployments\/([^/]+)/.exec(path);
	let prefix: string;
	let deployment: string | undefined;
	if (match) {
		prefix = match[1];
		deployment = decodeURIComponent(match[2]);
	} else {
		const host = url.hostname.toLowerCase();
		const isAzureHost = AZURE_OPENAI_HOST_SUFFIXES.some((suffix) =>
			host.endsWith(suffix),
		);
		if (!isAzureHost || (path !== "" && path !== "/openai")) {
			return undefined;
		}
		prefix = "";
	}
	const version =
		apiVersion?.trim() || url.searchParams.get("api-version") || undefined;
	return {
		baseUrl: `${url.origin}${prefix}/openai${version ? "" : "/v1"}`,
		...(deployment ? { deployment } : {}),
		...(version ? { apiVersion: version } : {}),
	};
}

/** Add `api-version` to requests under `baseUrl` that don't already carry one. */
export function withApiVersion(
	baseFetch: typeof fetch,
	baseUrl: string,
	apiVersion: string,
): typeof fetch {
	const wrapped = ((input, init) => {
		let url: URL;
		try {
			url = new URL(input instanceof Request ? input.url : input.toString());
		} catch {
			return baseFetch(input, init);
		}
		if (
			!url.toString().startsWith(baseUrl) ||
			url.searchParams.has("api-version")
		) {
			return baseFetch(input, init);
		}
		url.searchParams.set("api-version", apiVersion);
		return baseFetch(
			input instanceof Request ? new Request(url.toString(), input) : url.toString(),
			init,
		);
	}) as typeof fetch;
	const withPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(wrapped as FetchWithOptionalPreconnect).preconnect =
		typeof withPreconnect.preconnect === "function"
			? withPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return wrapped;
}

/** Azure-owned hosts authenticate API keys via the `api-key` header. */
export function isAzureOpenAIHost(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return AZURE_OPENAI_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
	} catch {
		return false;
	}
}
