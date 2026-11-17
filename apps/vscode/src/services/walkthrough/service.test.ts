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
const askResponse = mock(async (_text: string) => {})
let askResponseArgs: unknown[] = []
const openMultiFileDiff = mock(async (_input: unknown) => ({}))
mock.module("@/core/storage/disk", () => ({ ensureTaskDirectoryExists: async () => directory }))
mock.module("@/hosts/host-provider", () => ({ HostProvider: { diff: { openMultiFileDiff } } }))
mock.module("@/sdk/sdk-api-handler", () => ({
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
							review: {
								notes: [
									{
										kind: "risk",
										title: "Guard the value",
										text: "The value is used directly.",
										stop: "Reject empty input",
										path: "a.ts",
										lines: "new",
									},
								],
							},
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
let configuredSettingsEnabled = true
const actionPicks: unknown[] = []
mock.module("@/sdk/model-settings/background", () => ({
	useModelSettings: () => configuredSettingsEnabled,
	backgroundHandler: async (_state: unknown, _use: string, pick: unknown) => {
		actionPicks.push(pick)
		const { buildApiHandler } = await import("@/sdk/sdk-api-handler")
		return buildApiHandler({} as never, "act")
	},
}))
const { WalkthroughService } = await import("./service")

beforeEach(async () => {
	configuredSettingsEnabled = true
	actionPicks.length = 0
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
function controller() {
	return {
		task: {
			taskId: "task",
			handleWebviewAskResponse: async (type: string, text: string, ...rest: unknown[]) => {
				askResponseArgs = rest
				expect(type).toBe("messageResponse")
				await askResponse(text)
			},
		},
		stateManager: {
			getGlobalStateKey: (key: string) => (key === "modelSettings" ? { revision: 1 } : undefined),
		},
		postStateToWebview: async () => {},
		getWalkthroughCollectionInput: async (_taskId: string, scope: CollectionInput["scope"]) => ({ ...input, scope }),
		askResponse,
	} as unknown as Controller
}
function service() {
	return new WalkthroughService(controller())
}
const request = { taskId: "task", scope: "thread" as const }

describe("walkthrough service", () => {
	it("uses each Generate action pick without remembering it or changing the next action", async () => {
		const { generateChangeWalkthrough } = await import("@/core/controller/task/generateChangeWalkthrough")
		const host = controller()
		const first = { modelId: "first", levelId: "high" }
		const second = { modelId: "second", levelId: "default" }
		await generateChangeWalkthrough(host, { value: JSON.stringify({ ...request, pick: first }) })
		await generateChangeWalkthrough(host, { value: JSON.stringify({ ...request, pick: second }) })
		await generateChangeWalkthrough(host, { value: JSON.stringify(request) })
		expect(actionPicks).toEqual([first, second, undefined])
		expect(requests).toBe(3)
	})

	it("rejects a malformed action pick before Generate starts", async () => {
		const { generateChangeWalkthrough } = await import("@/core/controller/task/generateChangeWalkthrough")
		await expect(
			generateChangeWalkthrough(controller(), { value: JSON.stringify({ ...request, pick: { modelId: "m" } }) }),
		).rejects.toThrow()
		expect(actionPicks).toEqual([])
	})

	it("keys generated caches by review mode", async () => {
		const host = service()
		await host.generate(request)
		const reviewed = await host.generate({ ...request, reviewNotes: true })
		expect(requests).toBe(2)
		const reopened = service()
		const cached = await reopened.generate({ ...request, reviewNotes: true })
		expect(requests).toBe(2)
		expect(cached.review).toEqual(reviewed.review)
		const id = cached.review!.notes[0].id
		await reopened.sendNotes({
			...request,
			fingerprint: cached.fingerprint,
			reviewResponses: { [id]: { fix: true, reply: "Keep this API." } },
		})
		expect(askResponse.mock.calls[0][0]).toContain("Please fix this.")
		expect(askResponse.mock.calls[0][0]).toContain("Reply: Keep this API.")
	})
	it("opens the free walkthrough without constructing a model request", async () => {
		const walk = await service().get(request)
		expect(walk.source).toBe("fallback")
		expect(requests).toBe(0)
	})
	it("won't generate before the setup has moved, and says where to look", async () => {
		configuredSettingsEnabled = false
		await expect(service().generate(request)).rejects.toThrow("Open Settings")
		expect(requests).toBe(0)
	})
	it("caches one paid request, reloads it across services and regenerates only explicitly", async () => {
		const host = service()
		const first = await host.generate(request)
		expect(first.cacheHit).toBe(false)
		const cached = await service().generate(request)
		expect(cached.cacheHit).toBe(true)
		expect(requests).toBe(1)
		await host.generate({ ...request, regenerate: true })
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
	it("sends no composer-typed text, so thread: ids inside quoted hunks never authorize", async () => {
		await writeFile(path.join(directory, "a.ts"), "see thread:9_secret\n")
		input.edits[0].after = "see thread:9_secret\n"
		const host = service()
		const walk = await host.get(request)
		await host.sendNotes({ ...request, fingerprint: walk.fingerprint, stopNotes: { s1: "Explain." } })
		expect(askResponse.mock.calls[0][0]).toContain("thread:9_secret")
		// (images, files) only: no provenance argument.
		expect(askResponseArgs).toEqual([[], []])
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
		await expect(host.generate(request)).rejects.toThrow("Provider failed")
		expect((await host.get(request)).source).toBe("fallback")
		expect(requests).toBe(1)
	})
	it("rejects a different thread before any model call", async () => {
		await expect(service().get({ ...request, taskId: "other" })).rejects.toThrow("Open the requested thread")
		expect(requests).toBe(0)
	})
})

describe("authored walkthrough RPCs", () => {
	it("loads the saved document and sends notes with origin without collecting local files", async () => {
		const { saveAuthoredWalkthrough } = await import("./authored")
		const { getChangeWalkthrough } = await import("@/core/controller/task/getChangeWalkthrough")
		const { sendWalkthroughNotes } = await import("@/core/controller/task/sendWalkthroughNotes")
		const walk = await saveAuthoredWalkthrough("task", {
			title: "Remote review",
			origin: { label: "MR !12", url: "https://example.com/mr/12" },
			chapters: [
				{
					title: "Parser",
					stops: [
						{
							title: "Validate remote input",
							prose: "Validate input.",
							hunks: [{ path: "remote.ts", patch: "@@ -1 +1 @@\n-old\n+remote\n" }],
						},
					],
				},
			],
		})
		const host = controller()
		host.getWalkthroughCollectionInput = async () => {
			throw new Error("Must not collect git")
		}
		const request = {
			taskId: "task",
			scope: "authored" as const,
			authoredId: walk.authoredId,
			fingerprint: walk.fingerprint,
			stopNotes: { s1: "Explain remote." },
		}
		const rpc = { value: JSON.stringify(request) }
		expect(JSON.parse((await getChangeWalkthrough(host, rpc)).value)).toEqual(walk)
		await sendWalkthroughNotes(host, rpc)
		expect(askResponse.mock.calls[0][0]).toContain("Origin: MR !12 (https://example.com/mr/12)")
		expect(askResponse.mock.calls[0][0]).toContain("> Stop: Validate remote input")
		expect(askResponse.mock.calls[0][0]).toContain("> +remote")
		await expect(sendWalkthroughNotes(host, { value: JSON.stringify({ ...request, fingerprint: "stale" }) })).rejects.toThrow(
			"Changes moved",
		)
		await expect(getChangeWalkthrough(host, { value: JSON.stringify({ ...request, taskId: "other" }) })).rejects.toThrow(
			"Open the requested thread",
		)
		expect(requests).toBe(0)
	})
	it("refuses local diff, revert and generation for authored documents", async () => {
		const { openWalkthroughDiff } = await import("@/core/controller/task/openWalkthroughDiff")
		const { revertWalkthroughChange } = await import("@/core/controller/task/revertWalkthroughChange")
		const { generateChangeWalkthrough } = await import("@/core/controller/task/generateChangeWalkthrough")
		const rpc = { value: JSON.stringify({ taskId: "task", scope: "authored", confirmed: true }) }
		const host = controller()
		await expect(openWalkthroughDiff(host, rpc)).rejects.toThrow("no local diff")
		await expect(revertWalkthroughChange(host, rpc)).rejects.toThrow("cannot revert")
		await expect(generateChangeWalkthrough(host, rpc)).rejects.toThrow("cannot collect local changes or Generate")
		expect(openMultiFileDiff).not.toHaveBeenCalled()
		expect(requests).toBe(0)
	})
})
