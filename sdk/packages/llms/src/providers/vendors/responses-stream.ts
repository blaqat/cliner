import { APICallError } from "@ai-sdk/provider";
import { EventSourceParserStream } from "@ai-sdk/provider-utils";

// Reasoning can be silent for minutes. Bound silence generously, and also
// bound streams kept alive forever by gateway heartbeats/in_progress events.
export const RESPONSES_IDLE_TIMEOUT_MS = 5 * 60_000;
export const RESPONSES_TOTAL_TIMEOUT_MS = 30 * 60_000;

/** Enforce the Responses protocol's terminal event, independently of HTTP EOF. */
export function withResponsesStreamGuard(
	baseFetch: typeof fetch,
	{
		idleMs = RESPONSES_IDLE_TIMEOUT_MS,
		totalMs = RESPONSES_TOTAL_TIMEOUT_MS,
	} = {},
): typeof fetch {
	return (async (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
		);
		if (!url.pathname.endsWith("/responses")) return baseFetch(input, init);
		const parentSignal =
			init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const controller = new AbortController();
		let rejectInterrupted!: (error: unknown) => void;
		const interrupted = new Promise<never>((_, reject) => {
			rejectInterrupted = reject;
		});
		// A timeout can fire between reads, while the consumer handles a delta.
		void interrupted.catch(() => {});
		const error = (message: string, retryable = true, code?: string) =>
			new APICallError({
				message,
				url: `${url.origin}${url.pathname}`,
				requestBodyValues: undefined,
				isRetryable: retryable,
				...(code ? { cause: Object.assign(new Error(message), { code }) } : {}),
			});
		const stop = (reason: unknown) => {
			rejectInterrupted(reason);
			controller.abort(reason);
		};
		const abort = () =>
			stop(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"));
		parentSignal?.addEventListener("abort", abort, { once: true });
		if (parentSignal?.aborted) abort();
		let idleTimer: ReturnType<typeof setTimeout>;
		const resetIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(
				() =>
					stop(
						error(
							"Responses stream timed out after 5 minutes without an event. Retry the turn.",
							true,
							"ETIMEDOUT",
						),
					),
				idleMs,
			);
		};
		resetIdle();
		const totalTimer = setTimeout(
			() =>
				stop(
					error(
						"Responses stream exceeded the 30 minute limit. Retry the turn.",
						true,
						"ETIMEDOUT",
					),
				),
			totalMs,
		);
		const cleanup = () => {
			clearTimeout(idleTimer);
			clearTimeout(totalTimer);
			parentSignal?.removeEventListener("abort", abort);
		};
		try {
			const response = await Promise.race([
				baseFetch(input, { ...init, signal: controller.signal }),
				interrupted,
			]);
			if (
				!response.ok ||
				!response.body ||
				!response.headers.get("content-type")?.includes("text/event-stream")
			) {
				cleanup();
				return response;
			}
			const reader = response.body
				.pipeThrough(new TextDecoderStream())
				.pipeThrough(new EventSourceParserStream())
				.getReader();
			const cancel = () => {
				void reader.cancel().catch(() => {});
			};
			const encoder = new TextEncoder();
			let refusalText = "";
			const body = new ReadableStream<Uint8Array>({
				async pull(output) {
					try {
						const next = await Promise.race([reader.read(), interrupted]);
						if (next.done || next.value.data === "[DONE]") {
							throw error(
								"Responses stream ended without a terminal event. Retry the turn.",
								true,
								"ECONNRESET",
							);
						}
						resetIdle();
						const event = JSON.parse(next.value.data);
						if (
							event.type === "response.refusal.delta" &&
							typeof event.delta === "string"
						) {
							refusalText += event.delta;
						}
						if (
							event.type === "response.refusal.done" ||
							(event.type === "response.completed" && refusalText)
						) {
							throw error(
								`Model refused the request: ${event.refusal ?? (refusalText || "No refusal text provided")}`,
								false,
							);
						}
						if (
							event.type === "response.incomplete" &&
							!["max_output_tokens", "content_filter"].includes(
								event.response?.incomplete_details?.reason,
							)
						) {
							throw error(
								`Responses stream is incomplete: ${event.response?.incomplete_details?.reason ?? "unknown reason"}. Retry the turn.`,
							);
						}
						output.enqueue(
							encoder.encode(
								`data: ${next.value.data.replace(/\n/g, "\ndata: ")}\n\n`,
							),
						);
						if (
							[
								"response.completed",
								"response.incomplete",
								"response.failed",
								"error",
							].includes(event.type)
						) {
							output.close();
							cleanup();
							cancel();
							controller.abort();
						}
					} catch (reason) {
						output.error(reason);
						cleanup();
						cancel();
						controller.abort(reason);
					}
				},
				cancel(reason) {
					cleanup();
					cancel();
					controller.abort(reason);
				},
			});
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (reason) {
			cleanup();
			controller.abort(reason);
			throw reason;
		}
	}) as typeof fetch;
}
