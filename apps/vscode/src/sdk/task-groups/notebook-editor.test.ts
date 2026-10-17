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
	warn: vi.fn(),
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
	window: { showTextDocument: editor.show, showErrorMessage: editor.error, showWarningMessage: editor.warn },
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
	editor.warn.mockReset()
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
async function openStaleEditor(onRejected = vi.fn(async () => {})) {
	const pending = (await store.readPendingReview(groupId, "thread"))!
	const saved = vi.fn(async () => {})
	handle = await openPendingNoteEditor(
		store,
		{ taskGroupId: groupId, threadId: "thread", revision: pending.revision, slug: "plan" },
		saved,
		{ onRejected },
	)
	await store.stageChange(groupId, "thread", {
		op: "create",
		slug: "plan",
		name: "Plan",
		description: "",
		content: "new agent draft",
	})
	return { saved, onRejected, document: editor.show.mock.calls[0][0] }
}
it("keeps a stale editor save as a draft instead of losing it", async () => {
	const { saved, onRejected, document } = await openStaleEditor()
	editor.save?.({ uri: document.uri, getText: () => "stale text" })
	await vi.waitFor(() => expect(onRejected).toHaveBeenCalled())
	expect(saved).not.toHaveBeenCalled()
	expect((await store.readPending(groupId, "thread"))?.[0].content).toBe("new agent draft")
	expect((await store.readDrafts(groupId, "thread")).plan).toMatchObject({ content: "stale text" })
	const review = await store.reviewDiffs((await store.readPendingReview(groupId, "thread"))!, "thread")
	expect(review.changes[0].draft?.reason).toContain("newest review card")
	// Closing the tab removes only the temp file; the draft survives.
	editor.close?.(document)
	await vi.waitFor(async () => expect(fs.access(document.uri.fsPath)).rejects.toThrow())
	expect((await store.readDrafts(groupId, "thread")).plan.content).toBe("stale text")
})
it("keeps the temp file when the draft itself cannot be persisted", async () => {
	const { document } = await openStaleEditor()
	vi.spyOn(store, "saveRejectedEdit").mockRejectedValue(new Error("disk full"))
	await fs.writeFile(document.uri.fsPath, "precious")
	editor.save?.({ uri: document.uri, getText: () => "precious" })
	await vi.waitFor(() => expect(editor.error).toHaveBeenCalled())
	editor.close?.(document)
	await new Promise((resolve) => setTimeout(resolve, 50))
	expect(await fs.readFile(document.uri.fsPath, "utf8")).toBe("precious")
	await fs.rm(path.dirname(document.uri.fsPath), { recursive: true, force: true })
})
it("Retry persists the draft on the newest revision and then drops it", async () => {
	const { document, onRejected } = await openStaleEditor()
	editor.save?.({ uri: document.uri, getText: () => "stale text" })
	await vi.waitFor(() => expect(onRejected).toHaveBeenCalled())
	const draft = (await store.readDrafts(groupId, "thread")).plan
	const current = (await store.readPendingReview(groupId, "thread"))!
	await store.editPending(groupId, "thread", current.revision, "plan", draft.content, { supersedesDraftTs: draft.ts })
	expect((await store.readPending(groupId, "thread"))?.[0]).toMatchObject({ content: "stale text", editedByUser: true })
	expect(await store.readDrafts(groupId, "thread")).toEqual({})
})
it("a draft is moved to history, not dropped, when its review is discarded", async () => {
	const { document, onRejected } = await openStaleEditor()
	editor.save?.({ uri: document.uri, getText: () => "stale text" })
	await vi.waitFor(() => expect(onRejected).toHaveBeenCalled())
	const current = (await store.readPendingReview(groupId, "thread"))!
	await store.discardPendingChanges(groupId, "thread", current.revision)
	expect(await store.readDrafts(groupId, "thread")).toEqual({})
	expect((await store.history(groupId, "plan")).map((version) => version.content)).toContain("stale text")
})
it("goes straight to history when the review no longer exists", async () => {
	const { document, onRejected } = await openStaleEditor()
	const current = (await store.readPendingReview(groupId, "thread"))!
	await store.discardPendingChanges(groupId, "thread", current.revision)
	editor.save?.({ uri: document.uri, getText: () => "late text" })
	await vi.waitFor(() => expect(onRejected).toHaveBeenCalled())
	expect(await store.readDrafts(groupId, "thread")).toEqual({})
	expect((await store.history(groupId, "plan")).map((version) => version.content)).toContain("late text")
})
