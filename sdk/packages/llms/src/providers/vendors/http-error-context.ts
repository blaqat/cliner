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
}

/**
 * Azure OpenAI serves the Responses API at `/openai/v1/responses`, not under
 * `/openai/deployments/<name>` (where Chat Completions lives). Returns the
 * v1 base URL for Azure hosts, or undefined for everything else.
 */
export function resolveAzureResponsesEndpoint(
	baseUrl: string | undefined,
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
	const host = url.hostname.toLowerCase();
	if (!AZURE_OPENAI_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return undefined;
	}
	const path = url.pathname.replace(/\/+$/, "");
	const deployment = /^\/openai\/deployments\/([^/]+)/.exec(path)?.[1];
	if (deployment || path === "" || path === "/openai") {
		return {
			baseUrl: `${url.origin}/openai/v1`,
			...(deployment ? { deployment: decodeURIComponent(deployment) } : {}),
		};
	}
	return undefined;
}
