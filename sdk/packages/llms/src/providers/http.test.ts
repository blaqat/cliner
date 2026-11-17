import { describe, expect, it, vi } from "vitest";
import { resolveApiKey } from "./http";

describe("isolated API credentials", () => {
	it("keeps an explicitly empty isolated credential empty", async () => {
		const resolver = vi.fn(() => "other-profile-key");
		expect(
			await resolveApiKey({
				apiKey: "",
				apiKeyEnv: [],
				apiKeyResolver: resolver,
			}),
		).toBe("");
		expect(resolver).not.toHaveBeenCalled();
	});

	it("retains resolver fallback when isolation was not requested", async () => {
		expect(
			await resolveApiKey({ apiKey: "", apiKeyResolver: () => "legacy-key" }),
		).toBe("legacy-key");
	});
});
