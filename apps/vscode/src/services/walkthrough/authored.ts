import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ChangeWalkthrough, WalkthroughHunk, WalkthroughReadyMessage } from "@shared/Walkthrough"
import { ensureTaskDirectoryExists } from "@/core/storage/disk"
import { hash } from "./engine"

export const AUTHORED_LIMITS = { chapters: 8, stops: 60, hunks: 400, patchChars: 300000 }

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
	return value as Record<string, unknown>
}
function text(value: unknown, label: string, max: number, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max)
		throw new Error(`${label} must be ${allowEmpty ? "a" : "a nonempty"} string of at most ${max} characters`)
	return value
}
function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
	return value
}

/** Preserve source patch text while checking each hunk's declared line counts. */
export function parseAuthoredPatch(patch: string): Array<Pick<WalkthroughHunk, "patch" | "header" | "oldStart" | "newStart">> {
	const lines = patch.replace(/\r\n/g, "\n").split("\n")
	if (lines.at(-1) === "") lines.pop()
	const result: ReturnType<typeof parseAuthoredPatch> = []
	let i = 0
	let fileHeaders = 0
	while (i < lines.length && !lines[i].startsWith("@@")) {
		const line = lines[i++]
		if (line.startsWith("--- ")) fileHeaders++
		if (
			!/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to )/.test(
				line,
			)
		)
			throw new Error("Malformed patch: expected a unified @@ hunk or file diff")
	}
	if (fileHeaders > 1) throw new Error("Each patch must describe one file; split files into separate hunks inputs")
	while (i < lines.length) {
		const start = i
		const header = lines[i++]
		const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(header)
		if (!match) throw new Error("Malformed patch: expected @@ -old,count +new,count @@")
		if (match.slice(1).some((value) => value !== undefined && !Number.isSafeInteger(Number(value))))
			throw new Error("Malformed patch: line positions and counts must be safe integers")
		let oldCount = 0
		let newCount = 0
		while (i < lines.length && !lines[i].startsWith("@@")) {
			const line = lines[i++]
			if (line === "\\ No newline at end of file") continue
			if (line.startsWith(" ")) {
				oldCount++
				newCount++
			} else if (line.startsWith("-")) oldCount++
			else if (line.startsWith("+")) newCount++
			else throw new Error("Malformed patch: hunk lines must start with space, +, or -")
		}
		if (oldCount !== Number(match[2] ?? 1) || newCount !== Number(match[4] ?? 1))
			throw new Error(`Malformed patch: line counts do not match ${header}`)
		result.push({
			header,
			oldStart: Number(match[1]),
			newStart: Number(match[3]),
			patch: `${lines.slice(start, i).join("\n")}\n`,
		})
	}
	if (!result.length) throw new Error("Malformed patch: no unified @@ hunks found")
	return result
}

export function normalizeAuthoredWalkthrough(taskId: string, value: unknown, authoredId = randomUUID()): ChangeWalkthrough {
	const input = object(value, "walkthrough")
	const title = text(input.title, "title", 200)
	const focus = input.focus === undefined ? "" : text(input.focus, "focus", 4000, true)
	let origin: ChangeWalkthrough["origin"]
	if (input.origin !== undefined) {
		const source = object(input.origin, "origin")
		origin = { label: text(source.label, "origin.label", 300) }
		if (source.url !== undefined) {
			const url = text(source.url, "origin.url", 4000)
			if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("origin.url must use http or https")
			origin.url = url
		}
	}
	const chaptersInput = array(input.chapters, "chapters")
	if (!chaptersInput.length || chaptersInput.length > AUTHORED_LIMITS.chapters) throw new Error("Use 1–8 chapters")
	const hunks: WalkthroughHunk[] = []
	let stopCount = 0
	let patchChars = 0
	const chapters = chaptersInput.map((entry, chapterIndex) => {
		const chapter = object(entry, "chapter")
		return {
			id: `c${chapterIndex + 1}`,
			title: text(chapter.title, "chapter.title", 200),
			stops: array(chapter.stops, "chapter.stops").map((entry) => {
				if (++stopCount > AUTHORED_LIMITS.stops) throw new Error("Use at most 60 stops")
				const stop = object(entry, "stop")
				const hunkIds = array(stop.hunks, "stop.hunks").flatMap((entry) => {
					const hunk = object(entry, "hunk")
					const filePath = text(hunk.path, "hunk.path", 2000)
					const patch = text(hunk.patch, "hunk.patch", AUTHORED_LIMITS.patchChars)
					patchChars += patch.length
					if (patchChars > AUTHORED_LIMITS.patchChars) throw new Error("Use at most 300000 total patch characters")
					return parseAuthoredPatch(patch).map((part) => {
						if (hunks.length >= AUTHORED_LIMITS.hunks) throw new Error("Use at most 400 hunks")
						const id = `h${hunks.length + 1}`
						hunks.push({
							...part,
							id,
							path: filePath,
							fileId: hash([filePath]).slice(0, 24),
							fingerprint: hash([filePath, part.patch]),
							external: true,
						})
						return id
					})
				})
				return {
					id: `s${stopCount}`,
					title: text(stop.title, "stop.title", 200),
					prose: text(stop.prose, "stop.prose", 8000, true),
					hunkIds,
				}
			}),
		}
	})
	if (!stopCount) throw new Error("Include at least one stop; narrative stops may have no hunks")
	const content = { title, focus, origin, chapters, hunks }
	return {
		version: 1,
		taskId,
		scope: "authored",
		source: "authored",
		authoredId,
		...content,
		fingerprint: hash(content),
		support: [],
		warnings: [],
	}
}

export function walkthroughReady(walk: ChangeWalkthrough): WalkthroughReadyMessage {
	return {
		authoredId: walk.authoredId!,
		title: walk.title,
		origin: walk.origin,
		stopCount: walk.chapters.reduce((sum, chapter) => sum + chapter.stops.length, 0),
		fileCount: new Set(walk.hunks.map((hunk) => hunk.fileId)).size,
	}
}

export async function saveAuthoredWalkthrough(taskId: string, input: unknown): Promise<ChangeWalkthrough> {
	const walk = normalizeAuthoredWalkthrough(taskId, input)
	const directory = path.join(await ensureTaskDirectoryExists(taskId), "walkthroughs")
	await mkdir(directory, { recursive: true })
	await writeFile(path.join(directory, `${walk.authoredId}.json`), JSON.stringify(walk), { encoding: "utf8", flag: "wx" })
	return walk
}

export async function readAuthoredWalkthrough(taskId: string, authoredId?: string): Promise<ChangeWalkthrough> {
	if (!authoredId || !/^[a-f0-9-]{36}$/.test(authoredId)) throw new Error("A valid authoredId is required")
	try {
		const walk = JSON.parse(
			await readFile(path.join(await ensureTaskDirectoryExists(taskId), "walkthroughs", `${authoredId}.json`), "utf8"),
		) as ChangeWalkthrough
		if (
			walk.version !== 1 ||
			walk.taskId !== taskId ||
			walk.authoredId !== authoredId ||
			walk.scope !== "authored" ||
			walk.source !== "authored"
		)
			throw new Error("Invalid stored walkthrough")
		return walk
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Authored walkthrough not found in this thread")
		throw error
	}
}
