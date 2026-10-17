import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { NotebookStore } from "@/sdk/task-groups/notebook-store"

/** Each tab owns a revision. Saving a stale tab cannot overwrite a newer agent draft. */
export async function openPendingNoteEditor(
	store: NotebookStore,
	input: { taskGroupId: string; threadId: string; revision: string; slug: string },
	onSaved: (name: string) => Promise<void>,
) {
	const vscode = await import("vscode")
	const pending = await store.readPendingReview(input.taskGroupId, input.threadId)
	const change = pending?.changes.find((change) => change.slug === input.slug)
	if (!pending || pending.revision !== input.revision || !change || change.op === "delete")
		throw new Error("Use the newest review card")
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-pending-note-"))
	const file = path.join(directory, `${input.slug}.md`)
	await fs.writeFile(file, change.content ?? "")
	let revision = input.revision
	let saving = Promise.resolve()
	const save = vscode.workspace.onDidSaveTextDocument((document) => {
		if (document.uri.fsPath !== file) return
		const content = document.getText()
		saving = saving
			.then(async () => {
				revision = await store.editPending(input.taskGroupId, input.threadId, revision, input.slug, content)
				await onSaved(change.name)
			})
			.catch((error) => {
				void vscode.window.showErrorMessage(`Couldn't update the pending note: ${error.message}`)
			})
	})
	const close = vscode.workspace.onDidCloseTextDocument((document) => {
		if (document.uri.fsPath !== file) return
		save.dispose()
		close.dispose()
		void saving.finally(() => fs.rm(directory, { recursive: true, force: true }))
	})
	try {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false })
	} catch (error) {
		save.dispose()
		close.dispose()
		await fs.rm(directory, { recursive: true, force: true })
		throw error
	}
	return {
		dispose: () => {
			save.dispose()
			close.dispose()
			void fs.rm(directory, { recursive: true, force: true })
		},
	}
}
