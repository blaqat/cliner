import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createStorageContext } from "@/shared/storage/storage-context"
import { StateManager } from "../StateManager"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-stash-"))
})
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true })
})

/** A window: its own StateManager and storage over the shared directory. */
async function openWindow() {
	const storage = createStorageContext({ clineDir: dir, workspaceStorageDir: path.join(dir, "workspace") })
	const manager = new (StateManager as unknown as new (storage: unknown) => StateManager)(storage)
	;(StateManager as unknown as { instance: StateManager }).instance = manager
	await manager.loadFromStorage()
	return manager
}

const entry = (id: string) => ({ id, text: id, quotes: [], ts: 1 })
const ids = (entries: { id: string }[] | undefined) => (entries ?? []).map((e) => e.id)
const onDisk = () => ids(JSON.parse(fs.readFileSync(path.join(dir, "data", "globalState.json"), "utf-8")).promptStash)

describe("prompt stash across windows", () => {
	it("keeps a removal made in one window when another window stashes", async () => {
		const a = await openWindow()
		await a.applyPromptStash([entry("one"), entry("two")])
		const b = await openWindow()

		await a.applyPromptStash([entry("two")])
		expect(onDisk()).toEqual(["two"])

		// B still shows one and two, then stashes three on top of its stale list.
		await b.applyPromptStash([entry("three"), entry("one"), entry("two")])
		expect(onDisk()).toEqual(["three", "two"])
	})

	it("keeps an entry another window stashed when this one removes something", async () => {
		const a = await openWindow()
		await a.applyPromptStash([entry("one")])
		const b = await openWindow()
		await b.applyPromptStash([entry("two"), entry("one")])

		await a.applyPromptStash([])
		expect(onDisk()).toEqual(["two"])
		expect(ids(a.getGlobalStateKey("promptStash"))).toEqual(["two"])
	})

	it("removes the last entry for good", async () => {
		const a = await openWindow()
		await a.applyPromptStash([entry("one")])
		await a.applyPromptStash([])
		expect(onDisk()).toEqual([])
		expect(ids((await openWindow()).getGlobalStateKey("promptStash"))).toEqual([])
	})

	it("picks up another window's changes on refresh", async () => {
		const a = await openWindow()
		const b = await openWindow()
		await a.applyPromptStash([entry("one")])

		expect(b.refreshPromptStash()).toBe(true)
		expect(ids(b.getGlobalStateKey("promptStash"))).toEqual(["one"])
		expect(b.refreshPromptStash()).toBe(false)
	})
})
