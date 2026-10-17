import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { openPendingNoteEditor } from "@/hosts/vscode/NotebookPendingEditor"
import { NotebookStore } from "./notebook-store"
import { TaskGroupStore } from "./task-group-store"

const editor = vi.hoisted(() => ({
	save: undefined as ((doc: unknown) => void) | undefined,
	close: undefined as ((doc: unknown) => void) | undefined,
	show: vi.fn(),
	error: vi.fn(),
}))
vi.mock("vscode", () => ({
	workspace: {
		onDidSaveTextDocument: (callback: (doc: unknown) => void) => {
			editor.save = callback
			return { dispose() {} }
		},
		onDidCloseTextDocument: (callback: (doc: unknown) => void) => {
			editor.close = callback
			return { dispose() {} }
		},
		openTextDocument: async (file: string) => ({ uri: { fsPath: file } }),
	},
	window: { showTextDocument: editor.show, showErrorMessage: editor.error },
}))
let root: string
let store: NotebookStore
let groupId: string
let handle: { dispose(): void } | undefined
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-editor-test-"))
	store = new NotebookStore(root)
	groupId = (await new TaskGroupStore(root).createGroup({ title: "Task" })).id
	editor.show.mockReset().mockResolvedValue(undefined)
	editor.error.mockReset()
	await store.stageChange(groupId, "thread", { op: "create", slug: "plan", name: "Plan", description: "", content: "draft" })
})
afterEach(async () => {
	handle?.dispose()
	handle = undefined
	await fs.rm(root, { recursive: true, force: true })
})
it("opens a normal markdown tab and saving updates pending reads and the card callback", async () => {
	const pending = (await store.readPendingReview(groupId, "thread"))!
	const saved = vi.fn(async () => {})
	handle = await openPendingNoteEditor(
		store,
		{ taskGroupId: groupId, threadId: "thread", revision: pending.revision, slug: "plan" },
		saved,
	)
	const document = editor.show.mock.calls[0][0]
	expect(editor.show.mock.calls[0][1]).toEqual({ preview: false })
	expect(await fs.readFile(document.uri.fsPath, "utf8")).toBe("draft")
	editor.save?.({ uri: document.uri, getText: () => "user version" })
	await vi.waitFor(() => expect(saved).toHaveBeenCalledWith("Plan"))
	expect((await store.readThreadNote(groupId, "thread", "plan", "thread"))?.content).toBe("user version")
	expect(await store.consumeNotices(groupId, "thread")).toContain("build on this version")
	editor.save?.({ uri: document.uri, getText: () => "user second version" })
	await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(2))
	expect((await store.readPending(groupId, "thread"))?.[0].content).toBe("user second version")
})
it("refuses a stale editor save after the agent updates the draft", async () => {
	const pending = (await store.readPendingReview(groupId, "thread"))!
	const saved = vi.fn(async () => {})
	handle = await openPendingNoteEditor(
		store,
		{ taskGroupId: groupId, threadId: "thread", revision: pending.revision, slug: "plan" },
		saved,
	)
	await store.stageChange(groupId, "thread", {
		op: "create",
		slug: "plan",
		name: "Plan",
		description: "",
		content: "new agent draft",
	})
	editor.save?.({ uri: editor.show.mock.calls[0][0].uri, getText: () => "stale text" })
	await vi.waitFor(() => expect(editor.error).toHaveBeenCalled())
	expect(saved).not.toHaveBeenCalled()
	expect((await store.readPending(groupId, "thread"))?.[0].content).toBe("new agent draft")
})
