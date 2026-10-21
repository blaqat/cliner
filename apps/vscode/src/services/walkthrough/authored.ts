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

type ParsedPatchHunk = Pick<WalkthroughHunk, "patch" | "header" | "oldStart" | "newStart"> & { warning?: string }

const STRICT_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
const countText = (count: number) => (count === 1 ? "" : `,${count}`)

/**
 * Split a patch into hunks. Agents copy and trim diffs, so a header whose counts (or starts) don't
 * match its body is repaired from the body instead of rejected; the hunk carries a `warning` then.
 * Only patches with no usable hunk lines or with foreign lines in a body are rejected.
 */
export function parseAuthoredPatch(patch: string): ParsedPatchHunk[] {
	const lines = patch.replace(/\r\n/g, "\n").split("\n")
	while (lines.at(-1) === "") lines.pop()
	const result: ParsedPatchHunk[] = []
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
		const header = lines[i++]
		const body: string[] = []
		let oldCount = 0
		let newCount = 0
		let blankContext = false
		while (i < lines.length && !lines[i].startsWith("@@")) {
			let line = lines[i++]
			if (line === "\\ No newline at end of file") {
				body.push(line)
				continue
			}
			// Editors and agents strip the single space of a blank context line.
			if (line === "") {
				line = " "
				blankContext = true
			}
			if (line.startsWith(" ")) {
				oldCount++
				newCount++
			} else if (line.startsWith("-")) oldCount++
			else if (line.startsWith("+")) newCount++
			else throw new Error("Malformed patch: hunk lines must start with space, +, or -")
			body.push(line)
		}
		if (!oldCount && !newCount) throw new Error(`Malformed patch: hunk has no changed or context lines after ${header}`)
		const strict = STRICT_HEADER.exec(header)
		let oldStart: number
		let newStart: number
		let tail: string
		let declaredOk = false
		if (strict) {
			oldStart = Number(strict[1])
			newStart = Number(strict[3])
			tail = strict[5]
			if (![strict[1], strict[3]].every((value) => Number.isSafeInteger(Number(value))))
				throw new Error("Malformed patch: line positions and counts must be safe integers")
			declaredOk = oldCount === Number(strict[2] ?? 1) && newCount === Number(strict[4] ?? 1)
		} else {
			// Garbled header: salvage whatever starts and trailing label are readable.
			const closing = header.indexOf("@@", 2)
			const spec = closing === -1 ? header.slice(2) : header.slice(2, closing)
			tail = closing === -1 ? "" : header.slice(closing + 2)
			const oldMatch = /-\s*(\d+)/.exec(spec)
			const newMatch = /\+\s*(\d+)/.exec(spec)
			const safe = (match: RegExpExecArray | null) =>
				match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : undefined
			const guessedOld = safe(oldMatch)
			const guessedNew = safe(newMatch)
			oldStart = guessedOld ?? guessedNew ?? 1
			newStart = guessedNew ?? guessedOld ?? 1
		}
		if (declaredOk && !blankContext) {
			result.push({ header, oldStart, newStart, patch: `${[header, ...body].join("\n")}\n` })
			continue
		}
		const repaired = `@@ -${oldStart}${countText(oldCount)} +${newStart}${countText(newCount)} @@${tail}`
		result.push({
			header: repaired,
			oldStart,
			newStart,
			patch: `${[repaired, ...body].join("\n")}\n`,
			warning: repaired === header ? undefined : `\`${header.trim()}\` → \`${repaired}\``,
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
	const warnings: string[] = []
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
					return parseAuthoredPatch(patch).map(({ warning, ...part }) => {
						if (hunks.length >= AUTHORED_LIMITS.hunks) throw new Error("Use at most 400 hunks")
						const id = `h${hunks.length + 1}`
						if (warning) warnings.push(`Fixed the line counts in a hunk header in \`${filePath}\`: ${warning}`)
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
		warnings,
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
