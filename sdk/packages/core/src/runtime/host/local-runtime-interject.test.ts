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
		expect(host.pendingPromptsController.enqueue).toHaveBeenCalledWith(
			"parent",
			{
				prompt: "Interject",
				mode: undefined,
				delivery: "steer",
				userImages: ["image"],
				userFiles: ["file"],
			},
		);
		releaseAbort();
		await sending;
	});
});
