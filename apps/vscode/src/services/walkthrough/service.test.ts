import { afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Controller } from "@/core/controller"
import type { CollectionInput } from "./collection"
import { git } from "./collection"

setDefaultTimeout(30000)
let directory = ""
let requests = 0
let input: CollectionInput
let rejectGeneration = false
const profile = {
	id: "chosen",
	name: "Chosen",
	provider: "openai",
	modelId: "fixture-model",
	options: { openAiBaseUrl: "http://example.invalid" },
}
const askResponse = mock(async (_text: string) => {})
const openMultiFileDiff = mock(async (_input: unknown) => ({}))
mock.module("@/core/storage/disk", () => ({ ensureTaskDirectoryExists: async () => directory }))
mock.module("@/hosts/host-provider", () => ({ HostProvider: { diff: { openMultiFileDiff } } }))
mock.module("@/sdk/sdk-api-handler", () => ({
	buildSdkProviderConfig: (config: unknown) => ({
		providerId: "openai-compatible",
		modelId: profile.modelId,
		baseUrl: profile.options.openAiBaseUrl,
		config,
	}),
	buildApiHandler: () => ({
		async *createMessage() {
			requests++
			if (rejectGeneration) throw new Error("Provider failed")
			yield {
				type: "tool_calls",
				id: "response",
				tool_call: {
					call_id: "call",
					function: {
						name: "submit_walkthrough",
						arguments: {
							title: "Validate input",
							focus: "Reject empty input.",
							chapters: [
								{
									title: "Parser",
									stops: [{ title: "Reject empty input", prose: "The input is validated.", hunkIds: ["h1"] }],
								},
							],
							support: [],
						},
					},
				},
			}
		},
	}),
}))
const { WalkthroughService } = await import("./service")

beforeEach(async () => {
	directory = await realpath(await mkdtemp(path.join(tmpdir(), "walkthrough-service-")))
	requests = 0
	rejectGeneration = false
	askResponse.mockClear()
	openMultiFileDiff.mockClear()
	await git(directory, ["init", "-q"])
	await writeFile(path.join(directory, "a.ts"), "new\n")
	input = {
		taskId: "task",
		scope: "thread",
		roots: [directory],
		checkpointRoot: directory,
		checkpoints: [],
		runSpans: [1, 0, 0],
		messages: [
			{ role: "user", content: "Validate input" },
			{ role: "assistant", content: [{ type: "tool_use", id: "edit", name: "editor", input: { path: "a.ts" } }] },
			{ role: "assistant", content: "Validated input." },
		],
		edits: [
			{
				filePath: path.join(directory, "a.ts"),
				before: "old\n",
				after: "new\n",
				beforeExists: true,
				afterExists: true,
				toolCallId: "edit",
				runId: "run",
			},
		],
	}
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})
function service() {
	return new WalkthroughService({
		task: {
			taskId: "task",
			handleWebviewAskResponse: async (type: string, text: string) => {
				expect(type).toBe("messageResponse")
				await askResponse(text)
			},
		},
		stateManager: {
			getGlobalStateKey: (key: string) => (key === "apiConfigProfiles" ? [profile] : undefined),
			listSecretStorageKeys: () => ["profile:chosen:openAiApiKey"],
			getSecretForKey: () => "test-credential",
		},
		getWalkthroughCollectionInput: async (_taskId: string, scope: CollectionInput["scope"]) => ({ ...input, scope }),
		askResponse,
	} as unknown as Controller)
}
const request = { taskId: "task", scope: "thread" as const }

describe("walkthrough service", () => {
	it("opens the free walkthrough without constructing a model request", async () => {
		const walk = await service().get(request)
		expect(walk.source).toBe("fallback")
		expect(requests).toBe(0)
	})
	it("requires an explicitly selected saved profile", async () => {
		await expect(service().generate(request)).rejects.toThrow("Choose a saved API profile")
		expect(requests).toBe(0)
	})
	it("caches one paid request, reloads it across services and regenerates only explicitly", async () => {
		const host = service()
		const first = await host.generate({ ...request, profileId: "chosen" })
		expect(first.cacheHit).toBe(false)
		const cached = await service().generate({ ...request, profileId: "chosen" })
		expect(cached.cacheHit).toBe(true)
		expect(requests).toBe(1)
		await host.generate({ ...request, profileId: "chosen", regenerate: true })
		expect(requests).toBe(2)
	})
	it("sends one normal user message quoting the host's stops and hunks", async () => {
		const host = service()
		const walk = await host.get(request)
		await host.sendNotes({
			...request,
			fingerprint: walk.fingerprint,
			stopNotes: { s1: "Explain this." },
			overallNote: "Add tests.",
		})
		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse.mock.calls[0][0]).toContain("> a.ts")
		expect(askResponse.mock.calls[0][0]).toContain("> +new")
		expect(askResponse.mock.calls[0][0]).toEndWith("Add tests.")
		expect(requests).toBe(0)
	})
	it("opens a host-resolved diff and rejects unknown file IDs", async () => {
		const host = service()
		const walk = await host.get(request)
		await host.openDiff({ ...request, fingerprint: walk.fingerprint, fileId: walk.hunks[0].fileId })
		expect(openMultiFileDiff).toHaveBeenCalledTimes(1)
		await expect(host.openDiff({ ...request, fingerprint: walk.fingerprint, fileId: "forged" })).rejects.toThrow(
			"Unknown walkthrough file",
		)
	})
	it("requires inline confirmation and removes reverted edits from the live walkthrough", async () => {
		const host = service()
		const walk = await host.get(request)
		const action = { ...request, fingerprint: walk.fingerprint, hunkId: "h1" }
		await expect(host.revert(action)).rejects.toThrow("Confirm this revert inline")
		const updated = await host.revert({ ...action, confirmed: true })
		expect(await readFile(path.join(directory, "a.ts"), "utf8")).toBe("old\n")
		expect(updated.hunks).toEqual([])
	})
	it("rejects stale review notes and actions after external file edits", async () => {
		const host = service()
		const walk = await host.get(request)
		await writeFile(path.join(directory, "a.ts"), "manual\n")
		await expect(host.sendNotes({ ...request, fingerprint: walk.fingerprint, stopNotes: { s1: "Note" } })).rejects.toThrow(
			"Changes moved",
		)
		await expect(host.revert({ ...request, fingerprint: walk.fingerprint, hunkId: "h1", confirmed: true })).rejects.toThrow(
			"Changes moved",
		)
		expect(askResponse).not.toHaveBeenCalled()
	})
	it("leaves the fallback usable after generation fails without retrying", async () => {
		const host = service()
		rejectGeneration = true
		await expect(host.generate({ ...request, profileId: "chosen" })).rejects.toThrow("Provider failed")
		expect((await host.get(request)).source).toBe("fallback")
		expect(requests).toBe(1)
	})
	it("rejects a different thread before any model call", async () => {
		await expect(service().get({ ...request, taskId: "other" })).rejects.toThrow("Open the requested thread")
		expect(requests).toBe(0)
	})
})
