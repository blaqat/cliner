import { describe, expect, it, vi } from "vitest";
import { LocalRuntimeHost } from "./local-runtime-host";

// Exercise the host boundary without starting a provider or touching session storage.
describe("interject delivery", () => {
	it.each([
		false,
		true,
	])("aborts and enqueues the next turn before yielding, canStartRun=%s", async (canStartRun) => {
		const order: string[] = [];
		let releaseAbort: () => void = () => {};
		const host = {
			turnsInFlight: new Set(["parent"]),
			getSessionOrThrow: () => ({
				agent: { canStartRun: () => canStartRun },
				status: "idle",
				aborting: false,
			}),
			abort: vi.fn(() => {
				order.push("abort");
				return new Promise<void>((resolve) => {
					releaseAbort = resolve;
				});
			}),
			pendingPromptsController: {
				enqueue: vi.fn(() => {
					order.push("enqueue");
				}),
			},
		};
		const sending = LocalRuntimeHost.prototype.runTurn.call(host as never, {
			sessionId: "parent",
			prompt: "Interject",
			delivery: "interject",
			userImages: ["image"],
			userFiles: ["file"],
		});
		expect(order).toEqual(["abort", "enqueue"]);
		// The interjected prompt rides the queue with the "interject" delivery so
		// it stays hidden from queue listings and drains ahead of steer/queue.
		expect(host.pendingPromptsController.enqueue).toHaveBeenCalledWith(
			"parent",
			{
				prompt: "Interject",
				mode: undefined,
				delivery: "interject",
				userImages: ["image"],
				userFiles: ["file"],
			},
		);
		// Interject aborts the current turn, not the queued work.
		expect(host.abort).toHaveBeenCalledWith("parent", undefined, {
			preservePendingPrompts: true,
		});
		releaseAbort();
		await sending;
	});
});
