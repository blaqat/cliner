import { expect, it, vi } from "vitest"
import { handleGrpcRequest, type StreamingResponseHandler } from "../grpc-handler"

const handlers = vi.hoisted(() => ({ stream: undefined as StreamingResponseHandler<unknown> | undefined }))
vi.mock("@generated/hosts/vscode/protobus-services", () => ({
	serviceHandlers: {
		StateService: {
			subscribeToState: async (_controller: unknown, _request: unknown, stream: StreamingResponseHandler<unknown>) => {
				handlers.stream = stream
			},
		},
	},
}))
vi.mock("@/core/controller/grpc-recorder/grpc-recorder.builder", () => ({
	GrpcRecorderBuilder: { getRecorder: () => ({ recordRequest: vi.fn(), recordResponse: vi.fn() }) },
}))
vi.mock("@/shared/services/Logger", () => ({ Logger: { warn: vi.fn(), error: vi.fn() } }))

it("reports a rejected postMessage instead of acknowledging its history version", async () => {
	await handleGrpcRequest({} as never, async () => false, {
		service: "StateService",
		method: "subscribeToState",
		request_id: "state",
		message: {},
		is_streaming: true,
	})
	await expect(handlers.stream!({ stateJson: "{}" })).rejects.toThrow("Webview rejected streaming response")
})
