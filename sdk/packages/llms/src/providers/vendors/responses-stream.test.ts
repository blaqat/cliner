import { afterEach, describe, expect, it, vi } from "vitest";
import { withResponsesStreamGuard } from "./responses-stream";

const encoder = new TextEncoder();
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const terminal = { type: "response.completed", response: {} };
const url = "https://gateway.example/openai/responses?api-version=preview";
function transport() {
	let source!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn();
	const fetchMock = vi.fn(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						source = controller;
					},
					cancel,
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	return {
		fetchMock: fetchMock as unknown as typeof fetch,
		cancel,
		send: (text: string) => source.enqueue(encoder.encode(text)),
		sendBytes: (bytes: Uint8Array) => source.enqueue(bytes),
		end: () => source.close(),
	};
}
afterEach(() => vi.useRealTimers());
describe("Responses stream guard", () => {
	it.each([
		"response.completed",
		"response.incomplete",
		"response.failed",
		"error",
	])("closes on %s without waiting for HTTP EOF", async (type) => {
		const t = transport();
		const response = await withResponsesStreamGuard(t.fetchMock)(url);
		const event = {
			type,
			response: { incomplete_details: { reason: "max_output_tokens" } },
		};
		t.send(frame(event));
		expect(await response.text()).toBe(frame(event));
		await vi.waitFor(() => expect(t.cancel).toHaveBeenCalledOnce());
	});
	it("supports split UTF-8, CRLF, comments, multiline data and unknown events", async () => {
		const t = transport();
		const response = await withResponsesStreamGuard(t.fetchMock)(url);
		const pending = response.text();
		t.send(
			': ping\r\ndata: {"type":\r\ndata: "future.event", "text":"é"}\r\n\r\n',
		);
		const bytes = encoder.encode(frame({ ...terminal, text: "é" }));
		for (const byte of bytes) t.sendBytes(new Uint8Array([byte]));
		t.end();
		expect(await pending).toContain('"future.event"');
	});
	it.each([
		"",
		"data: [DONE]\n\n",
	])("rejects EOF or DONE without a terminal event", async (ending) => {
		const t = transport();
		const response = await withResponsesStreamGuard(t.fetchMock)(url);
		const pending = response.text();
		t.send(frame({ type: "response.created" }) + ending);
		t.end();
		await expect(pending).rejects.toMatchObject({
			message: expect.stringContaining("without a terminal event"),
			isRetryable: true,
		});
	});
	it("times out a stalled body even when fetch ignores abort", async () => {
		vi.useFakeTimers();
		const t = transport();
		const response = await withResponsesStreamGuard(t.fetchMock, {
			idleMs: 100,
			totalMs: 1000,
		})(url);
		const pending = expect(response.text()).rejects.toMatchObject({
			isRetryable: true,
			cause: { code: "ETIMEDOUT" },
		});
		await vi.advanceTimersByTimeAsync(100);
		await pending;
		expect(t.cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("bounds request initiation when no headers arrive", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | null | undefined;
		const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
			signal = init?.signal;
			return new Promise<Response>(() => {});
		});
		const pending = expect(
			withResponsesStreamGuard(fetchMock as typeof fetch, { idleMs: 100 })(url),
		).rejects.toMatchObject({ isRetryable: true });
		await vi.advanceTimersByTimeAsync(100);
		await pending;
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("resets idle time on events but bounds endless in_progress events", async () => {
		vi.useFakeTimers();
		const t = transport();
		const response = await withResponsesStreamGuard(t.fetchMock, {
			idleMs: 100,
			totalMs: 250,
		})(url);
		const pending = expect(response.text()).rejects.toMatchObject({
			message: expect.stringContaining("30 minute limit"),
		});
		for (let i = 0; i < 3; i++) {
			t.send(frame({ type: "response.in_progress" }));
			await vi.advanceTimersByTimeAsync(80);
		}
		await vi.advanceTimersByTimeAsync(10);
		await pending;
		expect(vi.getTimerCount()).toBe(0);
	});
	it("does not let comment keep-alives hide a stalled response", async () => {
		vi.useFakeTimers();
		const t = transport();
		const response = await withResponsesStreamGuard(t.fetchMock, {
			idleMs: 100,
		})(url);
		const pending = expect(response.text()).rejects.toMatchObject({
			isRetryable: true,
		});
		t.send(": ping\n\n");
		await vi.advanceTimersByTimeAsync(60);
		t.send(": ping\n\n");
		await vi.advanceTimersByTimeAsync(40);
		await pending;
	});
	it("cancels a pending body read promptly on user abort", async () => {
		const t = transport();
		const controller = new AbortController();
		const response = await withResponsesStreamGuard(t.fetchMock)(url, {
			signal: controller.signal,
		});
		const pending = expect(response.text()).rejects.toMatchObject({
			name: "AbortError",
		});
		controller.abort();
		await pending;
		expect(t.cancel).toHaveBeenCalledOnce();
	});
	it("cleans up when the consumer cancels", async () => {
		vi.useFakeTimers();
		const t = transport();
		const response = await withResponsesStreamGuard(t.fetchMock)(url);
		await response.body?.cancel();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("retains the full refusal when the server omits refusal.done", async () => {
		const t = transport();
		const response = await withResponsesStreamGuard(t.fetchMock)(url);
		const pending = expect(response.text()).rejects.toMatchObject({
			message: "Model refused the request: I cannot help",
			isRetryable: false,
		});
		t.send(
			frame({ type: "response.refusal.delta", delta: "I cannot " }) +
				frame({ type: "response.refusal.delta", delta: "help" }) +
				frame(terminal),
		);
		await pending;
	});

	it("passes non-SSE responses and other endpoints through", async () => {
		const response = new Response("{}", {
			headers: { "content-type": "application/json" },
		});
		const fetchMock = vi.fn(async () => response);
		expect(await withResponsesStreamGuard(fetchMock as typeof fetch)(url)).toBe(
			response,
		);
		expect(
			await withResponsesStreamGuard(fetchMock as typeof fetch)(
				"https://example.com/chat/completions",
			),
		).toBe(response);
	});
});
