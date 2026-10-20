import { execFile as execFileCallback } from "node:child_process"
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { Message, MessageWithMetadata } from "@cline/shared"
import type { ChangeWalkthrough, WalkthroughScope } from "@shared/Walkthrough"
import { applyPatch, reversePatch, structuredPatch } from "diff"
import { Logger } from "@/shared/services/Logger"
import { type ContentChange, type EditTurn, fallback, hash } from "./engine"

const execFile = promisify(execFileCallback)
const MAX_FILE = 2 * 1024 * 1024
const MAX_WARNING = 200

/**
 * An error whose message is safe to show in the webview: short, and free of
 * absolute host paths. Any other error is logged host-side and replaced by a
 * generic message when it would reach the webview.
 */
export class ReviewError extends Error {}

/** Logs the raw error host-side and returns a bounded warning for the webview. */
export function warningFor(label: string, error: unknown): string {
	Logger.warn(`[walkthrough] ${label}`, error)
	const detail = error instanceof ReviewError ? error.message : "could not be read (details are in the extension log)"
	return `${label}: ${detail}`.slice(0, MAX_WARNING)
}
export async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 30000 })).stdout
}

export async function readDisk(filePath: string): Promise<{ text: string; exists: boolean }> {
	try {
		const stat = await lstat(filePath)
		if (!stat.isFile() || stat.size > MAX_FILE) throw new ReviewError("Cannot review a non-file or a file over 2 MiB")
		return { text: await readFile(filePath, "utf8"), exists: true }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", exists: false }
		throw error
	}
}

export interface JournalEdit {
	toolCallId: string
	runId: string
	filePath: string
	before: string
	after: string
	beforeExists: boolean
	afterExists: boolean
}

export async function recordEdits(directory: string, edits: JournalEdit[]): Promise<void> {
	if (edits.length)
		await appendFile(
			path.join(directory, "walkthrough-edits.jsonl"),
			edits.map((e) => JSON.stringify(e)).join("\n") + "\n",
			"utf8",
		)
}

export async function readEdits(directory: string): Promise<JournalEdit[]> {
	try {
		const text = await readFile(path.join(directory, "walkthrough-edits.jsonl"), "utf8")
		return text
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as JournalEdit)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

const COMPLETION_TOOLS = new Set(["submit_and_exit", "attempt_completion"])
const PROSE_LINES = 3
const PROSE_CHARS = 320
const DETAIL_CHARS = 8000

/** The completion tool carries its summary in `summary` (submit_and_exit) or `result` (attempt_completion). */
function completionText(block: { name?: string; input?: unknown }): string {
	if (!block.name || !COMPLETION_TOOLS.has(block.name)) return ""
	let input = block.input
	if (typeof input === "string") {
		try {
			input = JSON.parse(input)
		} catch {
			return ""
		}
	}
	if (!input || typeof input !== "object") return ""
	const fields = input as Record<string, unknown>
	const text = fields.summary ?? fields.result
	return typeof text === "string" ? text.trim() : ""
}

/** A few lines of the text, ending in an ellipsis when something was cut. */
function shorten(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
	let short = lines.slice(0, PROSE_LINES).join("\n")
	if (short.length > PROSE_CHARS) short = `${short.slice(0, PROSE_CHARS - 1).trimEnd()}…`
	else if (lines.length > PROSE_LINES) short = `${short}…`
	return short
}

/**
 * A turn's prose is its final message: the completion summary, else the last
 * assistant text. The whole narration (plan, retries, summary) stays available
 * as `detail` whenever the short prose leaves something out.
 */
function summarizeTurn(texts: string[], completion: string): Pick<EditTurn, "prose" | "detail"> {
	const final = completion || texts.at(-1) || ""
	const narration = [...texts, ...(completion && !texts.includes(completion) ? [completion] : [])].join("\n\n").trim()
	const prose = shorten(final)
	return { prose, ...(narration && narration !== prose ? { detail: narration.slice(0, DETAIL_CHARS) } : {}) }
}

export function transcriptTurns(messages: Message[], runSpans: number[]): { turns: EditTurn[]; toolTurns: Map<string, string> } {
	const turns: EditTurn[] = []
	const texts = new Map<EditTurn, { texts: string[]; completion: string }>()
	const toolTurns = new Map<string, string>()
	let runCount = 0
	for (const [index, message] of messages.entries()) {
		const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
		const text = blocks
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n")
		const span = runSpans[index] ?? 0
		runCount += span
		const metadata = (message as MessageWithMetadata).metadata
		if (
			span > 0 &&
			!["compaction", "compaction_summary"].includes(String(metadata?.kind)) &&
			!["system", "status", "error"].includes(String(metadata?.displayRole))
		) {
			const turn: EditTurn = { id: `turn${runCount}`, prose: "", context: text, changes: [] }
			turns.push(turn)
			texts.set(turn, { texts: [], completion: "" })
		}
		const turn = turns.at(-1)
		if (!turn) continue
		if (message.role === "assistant") {
			const narration = texts.get(turn)!
			if (text.trim()) {
				narration.texts.push(text.trim())
				turn.context += `\nAssistant: ${text}`
			}
			for (const block of blocks)
				if (block.type === "tool_use") {
					toolTurns.set(block.id, turn.id)
					narration.completion = completionText(block) || narration.completion
				}
		}
	}
	for (const turn of turns) {
		const narration = texts.get(turn)!
		Object.assign(turn, summarizeTurn(narration.texts, narration.completion))
	}
	return { turns, toolTurns }
}

/** Workspace-relative (or module-prefixed) label for a warning; never an absolute path. */
function relativeLabel(filePath: string, roots: string[], fallbackLabel: string): string {
	try {
		return modulePath(filePath, roots)
	} catch {
		return fallbackLabel
	}
}

/** Root basenames are disambiguated deterministically when two modules have the same name. */
export function modulePath(filePath: string, roots: string[]): string {
	const root = [...roots].sort((a, b) => b.length - a.length).find((r) => filePath === r || filePath.startsWith(r + path.sep))
	if (!root) throw new ReviewError("File is outside the thread workspace")
	const relative = path.relative(root, filePath).split(path.sep).join("/")
	const name = path.basename(root)
	const duplicates = roots.filter((r) => path.basename(r) === name)
	const prefix = duplicates.length > 1 ? `${name}-${hash(root).slice(0, 6)}` : name
	return roots.length > 1 ? `${prefix}/${relative}` : relative
}

/**
 * Resolves symlinks (macOS /tmp is /private/tmp) so paths from different
 * sources compare equal. A file that no longer exists is judged by its nearest
 * existing ancestor, with the missing tail re-appended.
 */
export async function canonicalPath(filePath: string): Promise<string> {
	let ancestor = path.resolve(filePath)
	const tail: string[] = []
	for (;;) {
		try {
			return path.join(await realpath(ancestor), ...tail)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error
			const parent = path.dirname(ancestor)
			if (parent === ancestor) return path.resolve(filePath)
			tail.unshift(path.basename(ancestor))
			ancestor = parent
		}
	}
}

/** Like canonicalPath, but an unreadable path falls back to its lexical form. */
async function safeCanonical(filePath: string): Promise<string> {
	return canonicalPath(filePath).catch(() => path.resolve(filePath))
}

export async function gitRoots(paths: string[]): Promise<string[]> {
	const roots = new Set<string>()
	for (const cwd of paths) {
		try {
			roots.add(await safeCanonical((await git(cwd, ["rev-parse", "--show-toplevel"])).trim()))
		} catch {
			roots.add(await safeCanonical(cwd))
		}
	}
	return [...roots].sort()
}

async function snapshot(root: string, ref: string, file: string): Promise<{ text: string; exists: boolean }> {
	for (const tree of [ref, `${ref}^3`]) {
		try {
			const text = await git(root, ["show", `${tree}:${file}`])
			if (text.length > MAX_FILE) throw new ReviewError(`Checkpoint file exceeds 2 MiB: ${file}`)
			return { text, exists: true }
		} catch (error) {
			if (error instanceof ReviewError) throw error
		}
	}
	return { text: "", exists: false }
}

async function snapshotPaths(root: string, ref: string): Promise<string[]> {
	await git(root, ["cat-file", "-e", `${ref}^{tree}`])
	let untracked: string[] = []
	try {
		untracked = (await git(root, ["ls-tree", "-r", "-z", "--name-only", `${ref}^3`])).split("\0").filter(Boolean)
	} catch {
		/* Plain commits have no third parent. */
	}
	return untracked
}

export async function changesBetween(
	root: string,
	roots: string[],
	beforeRef: string,
	afterRef?: string,
	warnings: string[] = [],
): Promise<ContentChange[]> {
	// Commit trees cannot expose stash-only third parents.
	if (beforeRef === "HEAD") beforeRef = "HEAD^{tree}"
	if (afterRef === "HEAD") afterRef = "HEAD^{tree}"
	const changed = afterRef
		? (await git(root, ["diff", "--no-renames", "--name-only", "-z", beforeRef, afterRef, "--"])).split("\0").filter(Boolean)
		: (await git(root, ["diff", "--no-renames", "--name-only", "-z", beforeRef, "--"])).split("\0").filter(Boolean)
	const extras = afterRef
		? await snapshotPaths(root, afterRef).then((paths) => paths.filter(Boolean))
		: (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
	// Include checkpoint-untracked files, including ones subsequently deleted.
	const beforeUntracked = await snapshotPaths(root, beforeRef)
	const files = new Set([...changed, ...extras, ...beforeUntracked])
	const changes: ContentChange[] = []
	for (const file of [...files].sort()) {
		try {
			const filePath = path.resolve(root, file)
			const displayPath = modulePath(filePath, roots)
			const before = await snapshot(root, beforeRef, file)
			const after = afterRef ? await snapshot(root, afterRef, file) : await readDisk(filePath)
			if (before.text !== after.text || before.exists !== after.exists)
				changes.push({
					filePath,
					path: displayPath,
					before: before.text,
					after: after.text,
					beforeExists: before.exists,
					afterExists: after.exists,
				})
		} catch (error) {
			warnings.push(warningFor(relativeLabel(path.resolve(root, file), roots, file), error))
		}
	}
	return changes
}

export interface CollectionInput {
	taskId: string
	scope: WalkthroughScope
	roots: string[]
	messages: Message[]
	runSpans: number[]
	edits: JournalEdit[]
	checkpoints: { ref: string; runCount: number; kind?: "commit" | "stash" }[]
	checkpointRoot: string
}

export async function collect(
	input: CollectionInput,
): Promise<{ walk: ChangeWalkthrough; turns: EditTurn[]; changes: ContentChange[] }> {
	const roots = await gitRoots(input.roots)
	const { turns, toolTurns } = transcriptTurns(input.messages, input.runSpans)
	const warnings: string[] = []

	for (const edit of input.edits) {
		const turn = turns.find((t) => t.id === toolTurns.get(edit.toolCallId))
		// Edits from a truncated/forked transcript must never leak back into the review.
		if (!turn) continue
		try {
			// Journal paths are as the tool saw them; roots and checkpoint changes are real paths.
			const filePath = await safeCanonical(edit.filePath)
			const displayPath = modulePath(filePath, roots)
			const existing = turn.changes.find((c) => c.filePath === filePath)
			if (existing) {
				existing.after = edit.after
				existing.afterExists = edit.afterExists
			} else turn.changes.push({ ...edit, filePath, path: displayPath, turnId: turn.id })
		} catch (error) {
			warnings.push(warningFor("Recorded edit", error))
		}
	}
	const checkpoints = [...input.checkpoints].sort((a, b) => a.runCount - b.runCount)

	const checkpointRef = (checkpoint: CollectionInput["checkpoints"][number]) =>
		checkpoint.kind === "commit" ? `${checkpoint.ref}^{tree}` : checkpoint.ref
	const checkpointFor = (turn: EditTurn) =>
		checkpoints.filter((checkpoint) => checkpoint.runCount <= Number(turn.id.slice(4))).at(-1)

	if (
		input.scope === "thread" &&
		checkpoints.length &&
		(!turns.length || (checkpointFor(turns[0])?.runCount ?? 0) > checkpoints[0].runCount)
	) {
		try {
			const root = (await git(input.checkpointRoot, ["rev-parse", "--show-toplevel"])).trim()
			const changes = await changesBetween(
				root,
				roots,
				checkpointRef(checkpoints[0]),
				turns[0] && checkpointFor(turns[0]) ? checkpointRef(checkpointFor(turns[0])!) : undefined,
				warnings,
			)
			if (changes.length) {
				turns.unshift({
					id: "earlier",
					prose: "Earlier assistant messages are unavailable in the current transcript.",
					context: "",
					changes: changes.map((change) => ({ ...change, turnId: "earlier" })),
				})
				warnings.push("Earlier edits were recovered from checkpoints; their turn messages are unavailable.")
			}
		} catch (error) {
			warnings.push(warningFor("Earlier edits", error))
		}
	}
	for (const [index, turn] of turns.entries()) {
		const checkpoint = checkpointFor(turn)
		if (!checkpoint) continue
		try {
			const root = (await git(input.checkpointRoot, ["rev-parse", "--show-toplevel"])).trim()
			const next = turns[index + 1] ? checkpointFor(turns[index + 1]) : undefined
			const changes = await changesBetween(
				root,
				roots,
				checkpointRef(checkpoint),
				next ? checkpointRef(next) : undefined,
				warnings,
			)
			for (const change of changes) {
				const recorded = turn.changes.find((candidate) => candidate.filePath === change.filePath)
				if (recorded) {
					recorded.before = change.before
					recorded.beforeExists = change.beforeExists
				} else turn.changes.push({ ...change, turnId: turn.id })
			}
		} catch (error) {
			warnings.push(warningFor(turn.id, error))
		}
	}

	if (input.scope === "git") {
		const changes: ContentChange[] = []
		for (const root of roots) {
			try {
				changes.push(...(await changesBetween(root, roots, "HEAD", undefined, warnings)))
			} catch (error) {
				warnings.push(warningFor(path.basename(root), error))
			}
		}
		return { walk: fallback(input.taskId, input.scope, turns, changes, warnings), turns, changes }
	}
	const selected = input.scope === "last_turn" ? turns.slice(-1) : turns
	if (!input.edits.length && !checkpoints.length)
		warnings.push(
			"No recorded edits or checkpoints are available for this thread. Use whole git diff to review workspace changes.",
		)
	if (roots.length > 1 && checkpoints.length && !input.edits.length)
		warnings.push(
			"Older checkpoints cover only the thread's primary git root. Other modules need recorded edits or whole git diff.",
		)
	// Review the net live change once, rather than showing edits later overwritten by the thread.
	const byFile = new Map<string, ContentChange>()
	for (const change of selected.flatMap((turn) => turn.changes)) {
		const first = byFile.get(change.filePath)
		byFile.set(change.filePath, {
			...change,
			before: first?.before ?? change.before,
			beforeExists: first?.beforeExists ?? change.beforeExists,
			turnId: undefined,
		})
	}
	const changes: ContentChange[] = []
	for (const change of byFile.values()) {
		try {
			const disk = await readDisk(change.filePath)
			if (disk.text !== change.after || disk.exists !== change.afterExists)
				warnings.push(`${change.path}: changed after the recorded edit; showing current file contents.`)
			changes.push({ ...change, after: disk.text, afterExists: disk.exists })
		} catch (error) {
			warnings.push(warningFor(change.path, error))
		}
	}
	return { walk: fallback(input.taskId, input.scope, selected, changes, warnings), turns: selected, changes }
}

let revertQueue: Promise<unknown> = Promise.resolve()

/** Test seams around the final read and atomic capture. */
export interface RevertHooks {
	beforeWrite?: () => Promise<void>
	afterRead?: () => Promise<void>
	afterCapture?: () => Promise<void>
}

const STALE_FILE = "File changed since this walkthrough. Refresh before reverting."

async function isInside(candidate: string, root: string): Promise<boolean> {
	return candidate === root || candidate.startsWith(root + path.sep)
}

/**
 * The directory must resolve (through symlinks) to a place inside one of the
 * workspace roots. A missing directory is judged by its nearest existing
 * ancestor, so a deleted directory can be recreated but a symlinked one can
 * never lead the write outside the workspace.
 */
async function assertDirectoryInWorkspace(directory: string, roots: string[]): Promise<string> {
	let ancestor = directory
	for (;;) {
		try {
			await lstat(ancestor)
			break
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			const parent = path.dirname(ancestor)
			if (parent === ancestor) throw new ReviewError("Cannot revert outside the thread workspace")
			ancestor = parent
		}
	}
	let resolved: string
	try {
		resolved = await realpath(ancestor)
	} catch (error) {
		// A dangling symlink exists for lstat but cannot be resolved.
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new ReviewError("Cannot revert through a symlinked directory")
		throw error
	}
	for (const root of roots) {
		const realRoot = await realpath(root).catch(() => undefined)
		if (realRoot && (await isInside(resolved, realRoot))) return path.resolve(resolved, path.relative(ancestor, directory))
	}
	throw new ReviewError("Cannot revert outside the thread workspace")
}

/**
 * Reverts only an unchanged reviewed snapshot; later edits always require a
 * refresh. Reverts run one at a time. Capture the directory entry before comparing it,
 * and publish the replacement exclusively so a concurrent save is never overwritten.
 */
export function revertChange(
	change: ContentChange,
	walk: ChangeWalkthrough,
	hunkId: string | undefined,
	roots: string[],
	hooks: RevertHooks = {},
): Promise<void> {
	const run = revertQueue.then(() => performRevert(change, walk, hunkId, roots, hooks))
	revertQueue = run.catch(() => undefined)
	return run
}

async function performRevert(
	change: ContentChange,
	walk: ChangeWalkthrough,
	hunkId: string | undefined,
	roots: string[],
	hooks: RevertHooks,
): Promise<void> {
	try {
		const unchanged = (disk: { text: string; exists: boolean }) =>
			disk.text === change.after && disk.exists === change.afterExists
		const current = await readDisk(change.filePath)
		if (!unchanged(current)) throw new ReviewError(STALE_FILE)
		if (current.text.includes("\0") || change.before.includes("\0"))
			throw new ReviewError("Binary changes cannot be reverted here")
		let restored = change.before
		if (hunkId) {
			const hunk = walk.hunks.find(
				(h) => h.id === hunkId && h.fileId === hash([change.filePath, change.turnId]).slice(0, 24),
			)
			if (!hunk || hunk.synthetic) throw new ReviewError("Unknown or non-text hunk")
			const patch = structuredPatch(change.path, change.path, change.before, change.after, "", "", { context: 3 })
			const part = patch.hunks.find((p) => p.oldStart === hunk.oldStart && p.newStart === hunk.newStart)
			if (!part) throw new ReviewError("Hunk is no longer available")
			const result = applyPatch(current.text, reversePatch({ ...patch, hunks: [part] }), { fuzzFactor: 0 })
			if (result === false) throw new ReviewError("Cannot apply the reverse hunk safely")
			restored = result
		}
		const removing = !change.beforeExists && (!hunkId || restored === "")
		let directory = await assertDirectoryInWorkspace(path.dirname(change.filePath), roots)
		if (!removing) {
			await mkdir(directory, { recursive: true })
			// Creating directories must not have walked through a symlink either.
			directory = await assertDirectoryInWorkspace(directory, roots)
		}
		const target = path.join(directory, path.basename(change.filePath))
		await hooks.beforeWrite?.()
		// Compare-and-write: the check above can be stale by now.
		if (!unchanged(await readDisk(target))) throw new ReviewError(STALE_FILE)
		await hooks.afterRead?.()
		const temporary = await mkdtemp(path.join(directory, ".cline-revert-"))
		const captured = path.join(temporary, "captured")
		let held = false
		let preserve = false
		try {
			if (current.exists) {
				await rename(target, captured)
				held = true
			}
			await hooks.afterCapture?.()
			if (!unchanged(await readDisk(held ? captured : target))) throw new ReviewError(STALE_FILE)
			if (removing) {
				// A save that recreated the pathname belongs to the user.
				if ((await readDisk(target)).exists) throw new ReviewError(STALE_FILE)
			} else {
				const replacement = path.join(temporary, "replacement")
				const mode = held ? (await lstat(captured)).mode & 0o777 : 0o666
				await writeFile(replacement, restored, { encoding: "utf8", mode })
				// Unlike rename, link fails if a concurrent writer recreated target.
				await link(replacement, target)
			}
		} catch (error) {
			if (held) {
				try {
					await link(captured, target)
				} catch {
					preserve = true
					throw new ReviewError(`${STALE_FILE} Saved the captured file in ${path.basename(temporary)}/captured.`)
				}
			}
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ReviewError(STALE_FILE)
			throw error
		} finally {
			if (!preserve) await rm(temporary, { recursive: true, force: true })
		}
	} catch (error) {
		if (error instanceof ReviewError) throw error
		Logger.warn(`[walkthrough] Revert of ${change.filePath} failed`, error)
		throw new ReviewError(`Could not revert ${change.path}`)
	}
}
