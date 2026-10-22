import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { NotebookStore } from "@/sdk/task-groups/notebook-store"

interface PendingEditorOptions {
	/** Opens this text (a rejected-save draft) instead of the staged content. */
	initialContent?: string
	/** The draft `initialContent` came from; dropped once an edit is persisted. */
	draftTs?: number
	/** A save was rejected and kept as a draft (or history entry); the review card should refresh. */
	onRejected?: () => Promise<void>
}

/**
 * Each tab owns a revision. Saving a stale tab cannot overwrite a newer agent
 * draft; the rejected text is kept as a recoverable draft instead, and the
 * temp file is only removed once everything saved in it is persisted somewhere.
 */
export async function openPendingNoteEditor(
	store: NotebookStore,
	input: { taskGroupId: string; threadId: string; revision: string; slug: string },
	onSaved: (name: string) => Promise<void>,
	options: PendingEditorOptions = {},
) {
	const vscode = await import("vscode")
	const pending = await store.readPendingReview(input.taskGroupId, input.threadId)
	const change = pending?.changes.find((change) => change.slug === input.slug)
	if (
		!pending ||
		pending.revision !== input.revision ||
		!change ||
		(change.op === "delete" && options.initialContent === undefined)
	)
		throw new Error("Use the newest review card")
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-pending-note-"))
	const file = path.join(directory, `${input.slug}.md`)
	await fs.writeFile(file, options.initialContent ?? change.content ?? "")
	let revision = input.revision
	let draftTs = options.draftTs
	// Set when a rejected save could not be persisted anywhere else: the temp file is then the only copy.
	let tempFileHoldsOnlyCopy = false
	let saving = Promise.resolve()
	const removeTempFile = () => (tempFileHoldsOnlyCopy ? Promise.resolve() : fs.rm(directory, { recursive: true, force: true }))
	const keepRejectedEdit = async (content: string, reason: string) => {
		try {
			const kept = await store.saveRejectedEdit(input.taskGroupId, input.threadId, input.slug, content, reason)
			tempFileHoldsOnlyCopy = false
			// A later successful save from this tab supersedes the draft it just wrote.
			draftTs = kept.kind === "draft" ? kept.ts : undefined
			void vscode.window.showWarningMessage(
				kept.kind === "draft"
					? `Your edit to "${change.name}" wasn't applied (${reason}). It's kept as a draft on the review card.`
					: `Your edit to "${change.name}" wasn't applied (${reason}). It's saved in the note's history.`,
			)
		} catch {
			tempFileHoldsOnlyCopy = true
			void vscode.window.showErrorMessage(
				`Couldn't update the pending note (${reason}) or keep a draft. Your text is still in ${file}.`,
			)
			return
		}
		await options.onRejected?.()
	}
	const save = vscode.workspace.onDidSaveTextDocument((document) => {
		if (document.uri.fsPath !== file) return
		const content = document.getText()
		saving = saving
			.then(async () => {
				try {
					revision = await store.editPending(input.taskGroupId, input.threadId, revision, input.slug, content, {
						supersedesDraftTs: draftTs,
					})
				} catch (error) {
					await keepRejectedEdit(content, error instanceof Error ? error.message : String(error))
					return
				}
				draftTs = undefined
				tempFileHoldsOnlyCopy = false
				await onSaved(change.name)
			})
			.catch((error) => {
				void vscode.window.showErrorMessage(`Couldn't refresh the pending note: ${error.message}`)
			})
	})
	const close = vscode.workspace.onDidCloseTextDocument((document) => {
		if (document.uri.fsPath !== file) return
		save.dispose()
		close.dispose()
		void saving.finally(removeTempFile)
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
			void saving.finally(removeTempFile)
		},
	}
}
