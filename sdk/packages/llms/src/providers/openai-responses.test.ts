import type {
	AgentMessage,
	AgentModelEvent,
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider, createOpenAICompatibleProvider } from "./ai-sdk";

const tool = {
	name: "lookup",
	description: "Look up a value",
	inputSchema: {
		type: "object",
		properties: { key: { type: "string" } },
		required: ["key"],
	},
};
const user: AgentMessage = {
	id: "u",
	role: "user",
	createdAt: new Date(),
	content: [{ type: "text", text: "Look it up" }],
};
const completed = {
	type: "response.completed",
	response: {
		usage: {
			input_tokens: 12,
			input_tokens_details: { cached_tokens: 3 },
			output_tokens: 8,
			output_tokens_details: { reasoning_tokens: 5 },
		},
	},
};
const created = {
	type: "response.created",
	response: { id: "resp_1", created_at: 1, model: "custom-model" },
};
function sse(events: unknown[]) {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
function textStream() {
	return sse([
		created,
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1" },
		},
		...["Hello", " world"].map((delta) => ({
			type: "response.output_text.delta",
			item_id: "msg_1",
			delta,
		})),
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [
					{ type: "output_text", text: "Hello world", annotations: [] },
				],
			},
		},
		completed,
	]);
}
function toolStream() {
	const events: unknown[] = [created];
	for (const [index, text] of ["Check the key", ""].entries()) {
		const item = {
			type: "reasoning",
			id: `rs_${index}`,
			encrypted_content: `opaque_${index}`,
		};
		events.push({
			type: "response.output_item.added",
			output_index: index,
			item: { ...item, encrypted_content: null },
		});
		if (text)
			events.push({
				type: "response.reasoning_summary_text.delta",
				item_id: item.id,
				summary_index: 0,
				delta: text,
			});
		events.push({
			type: "response.output_item.done",
			output_index: index,
			item,
		});
	}
	const item = {
		type: "function_call",
		id: "fc_item",
		call_id: "call_1",
		name: "lookup",
		status: "completed",
		arguments: '{"key":"a"}',
	};
	events.push(
		{
			type: "response.output_item.added",
			output_index: 2,
			item: { ...item, arguments: "" },
		},
		{
			type: "response.function_call_arguments.delta",
			item_id: item.id,
			output_index: 2,
			delta: item.arguments,
		},
		{ type: "response.output_item.done", output_index: 2, item },
		completed,
	);
	return sse(events);
}
async function collect(stream: AsyncIterable<AgentModelEvent>) {
	const events: AgentModelEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
async function setup(bodies: string[]) {
	let index = 0;
	const fetchMock = vi.fn(
		async () =>
			new Response(bodies[index++], {
				headers: { "content-type": "text/event-stream" },
			}),
	);
	const config = {
		providerId: "openai-compatible",
		apiKey: "custom-key",
		baseUrl: "https://compatible.example/v1",
		headers: { "X-Custom": "yes" },
		fetch: fetchMock as typeof fetch,
	};
	const context = {
		config,
		provider: { id: config.providerId, name: "Compatible", models: [] },
		model: {
			id: "custom-model",
			providerId: config.providerId,
			name: "Custom",
		},
	} as GatewayProviderContext;
	const request: GatewayStreamRequest = {
		providerId: config.providerId,
		modelId: "custom-model",
		messages: [user],
		tools: [tool],
	};
	return {
		fetchMock,
		config,
		context,
		request,
		provider: await createOpenAIProvider(config),
	};
}
// Match AgentRuntime's coalescing and persist/reload the resulting history.
function assistant(events: AgentModelEvent[]): AgentMessage {
	const content: AgentMessage["content"][number][] = [];
	for (const event of events) {
		if (event.type === "reasoning-delta") {
			const last = content.at(-1);
			if (last?.type === "reasoning") {
				last.text += event.text;
				last.metadata = event.metadata ?? last.metadata;
			} else
				content.push({
					type: "reasoning",
					text: event.text,
					metadata: event.metadata,
				});
		} else if (event.type === "tool-call-delta")
			content.push({
				type: "tool-call",
				toolCallId: event.toolCallId!,
				toolName: event.toolName!,
				input: event.input,
				metadata: event.metadata,
			});
		else if (event.type === "text-delta")
			content.push({ type: "text", text: event.text });
	}
	return JSON.parse(
		JSON.stringify({
			id: "a",
			role: "assistant",
			createdAt: new Date(),
			content,
		}),
	);
}
describe("OpenAI Compatible Responses runtime", () => {
	it("streams text and usage with the configured endpoint, credentials, headers and model", async () => {
		const { provider, request, context, fetchMock } = await setup([
			textStream(),
		]);
		const events = await collect(await provider.stream(request, context));
		expect(
			events
				.filter((e) => e.type === "text-delta")
				.map((e) => e.text)
				.join(""),
		).toBe("Hello world");
		expect(events.find((e) => e.type === "usage")).toMatchObject({
			usage: {
				inputTokens: 12,
				outputTokens: 3,
				reasoningTokenCount: 5,
				cacheReadTokens: 3,
			},
		});
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://compatible.example/v1/responses");
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer custom-key",
		);
		expect(new Headers(init.headers).get("X-Custom")).toBe("yes");
		expect(JSON.parse(init.body as string)).toMatchObject({
			model: "custom-model",
			stream: true,
			store: false,
			include: ["reasoning.encrypted_content"],
		});
	});
	it("replays separate reasoning items, encrypted-only items and call ids through tools and later turns", async () => {
		const { provider, request, context, fetchMock } = await setup([
			toolStream(),
			textStream(),
			textStream(),
		]);
		const events = await collect(await provider.stream(request, context));
		expect(events.find((e) => e.type === "tool-call-delta")).toMatchObject({
			toolCallId: "call_1",
			metadata: { openaiItemId: "fc_item" },
		});
		const result: AgentMessage = {
			id: "r",
			role: "tool",
			createdAt: new Date(),
			content: [
				{
					type: "tool-result",
					toolCallId: "call_1",
					toolName: "lookup",
					output: "found",
				},
			],
		};
		const messages = [user, assistant(events), result];
		const next = await collect(
			await provider.stream({ ...request, messages }, context),
		);
		await collect(
			await provider.stream(
				{
					...request,
					messages: [...messages, assistant(next), { ...user, id: "u2" }],
				},
				context,
			),
		);
		for (const call of fetchMock.mock.calls.slice(1)) {
			const body = JSON.parse(
				(call as unknown as [string, RequestInit])[1].body as string,
			);
			expect(body.input).toEqual(
				expect.arrayContaining([
					{
						type: "reasoning",
						id: "rs_0",
						encrypted_content: "opaque_0",
						summary: [{ type: "summary_text", text: "Check the key" }],
					},
					{
						type: "reasoning",
						id: "rs_1",
						encrypted_content: "opaque_1",
						summary: [],
					},
					expect.objectContaining({
						type: "function_call",
						call_id: "call_1",
						name: "lookup",
						arguments: '{"key":"a"}',
					}),
					expect.objectContaining({
						type: "function_call_output",
						call_id: "call_1",
					}),
				]),
			);
		}
	});
	it("forwards cancellation to fetch and finishes as aborted", async () => {
		const { config, context, request } = await setup([]);
		const controller = new AbortController();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const fetchMock = vi.fn(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
					started();
				}),
		);
		const provider = await createOpenAIProvider({
			...config,
			fetch: fetchMock as typeof fetch,
		});
		const pending = collect(
			await provider.stream({ ...request, signal: controller.signal }, context),
		);
		await ready;
		controller.abort();
		expect(await pending).toContainEqual(
			expect.objectContaining({ type: "finish", reason: "aborted" }),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("cancels an active response after streaming text", async () => {
		const { config, context, request } = await setup([]);
		const controller = new AbortController();
		let transportAborted = false;
		const fetchMock = vi.fn(
			async (_url: unknown, init?: RequestInit) =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							stream.enqueue(
								new TextEncoder().encode(
									sse([
										created,
										{
											type: "response.output_item.added",
											output_index: 0,
											item: { type: "message", id: "msg_1" },
										},
										{
											type: "response.output_text.delta",
											item_id: "msg_1",
											delta: "partial",
										},
									]),
								),
							);
							init?.signal?.addEventListener(
								"abort",
								() => {
									transportAborted = true;
									stream.error(new DOMException("Aborted", "AbortError"));
								},
								{ once: true },
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const provider = await createOpenAIProvider({
			...config,
			fetch: fetchMock as typeof fetch,
		});
		const events: AgentModelEvent[] = [];
		for await (const event of await provider.stream(
			{ ...request, signal: controller.signal },
			context,
		)) {
			events.push(event);
			if (event.type === "text-delta") controller.abort();
		}
		expect(transportAborted).toBe(true);
		expect(events).toContainEqual({ type: "text-delta", text: "partial" });
		expect(events).toContainEqual({ type: "finish", reason: "aborted" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses chat completions again when the compatible adapter is rebuilt", async () => {
		const chunk = {
			id: "chat",
			object: "chat.completion.chunk",
			created: 1,
			model: "custom-model",
			choices: [{ index: 0, delta: { content: "Chat" }, finish_reason: null }],
		};
		const { config, context, request, fetchMock } = await setup([
			sse([
				chunk,
				{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			]) + "data: [DONE]\n\n",
		]);
		const provider = await createOpenAICompatibleProvider(config);
		const events = await collect(await provider.stream(request, context));
		expect(events).toContainEqual({ type: "text-delta", text: "Chat" });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://compatible.example/v1/chat/completions");
		expect(JSON.parse(init.body as string)).not.toHaveProperty("include");
	});
});
