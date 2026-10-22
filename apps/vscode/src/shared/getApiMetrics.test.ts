import { describe, it } from "bun:test"
import { strict as assert } from "node:assert"
import type { ClineMessage } from "./ExtensionMessage"
import { getCostBreakdown } from "./getApiMetrics"

const say = (say: string, data: object, ts = 1) => ({ ts, type: "say", say, text: JSON.stringify(data) }) as ClineMessage

describe("getCostBreakdown", () => {
	it("groups requests by model, with subagents and unrecorded requests on their own rows, most expensive first", () => {
		const rows = getCostBreakdown([
			say("api_req_started", {}),
			say("api_req_started", { tokensIn: 100, tokensOut: 10, cost: 0.2, modelId: "claude-x", providerId: "anthropic" }),
			say("api_req_started", { tokensIn: 50, tokensOut: 5, cost: 0.05, modelId: "gpt-y", providerId: "openai-native" }),
			say("api_req_started", { tokensIn: 100, tokensOut: 10, cost: 0.2, modelId: "claude-x", providerId: "anthropic" }),
			say("api_req_started", { tokensIn: 30, tokensOut: 3, cost: 0.03 }),
			say("deleted_api_reqs", { tokensIn: 20, tokensOut: 2, cost: 0.01 }),
			say("subagent_usage", { source: "subagents", tokensIn: 30, tokensOut: 4, cacheReads: 8, cacheWrites: 2, cost: 0.1 }),
			say("text", { cost: 9 }),
		])
		assert.deepEqual(
			rows.map((row) => [row.key, row.tokensIn, row.tokensOut, Math.round(row.cost * 100)]),
			[
				["model:anthropic:claude-x", 200, 20, 40],
				["subagents", 40, 4, 10],
				["model:openai-native:gpt-y", 50, 5, 5],
				["earlier", 50, 5, 4],
			],
		)
		// Cached input counts toward a row's input.
		assert.equal(rows[1].cacheTokens, 10)
		assert.equal(rows[0].modelId, "claude-x")
		assert.equal(rows[0].providerId, "anthropic")
	})

	it("is empty before any request has usage", () => {
		assert.deepEqual(getCostBreakdown([say("api_req_started", {})]), [])
	})
})
