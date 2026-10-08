/**
 * Apply Patch parser and patch model types.
 *
 * This parser supports the Cline apply_patch format used by the legacy runtime.
 */

import { throwIfAborted } from "./edit-validation";

export const PATCH_MARKERS = {
	BEGIN: "*** Begin Patch",
	END: "*** End Patch",
	ADD: "*** Add File: ",
	UPDATE: "*** Update File: ",
	DELETE: "*** Delete File: ",
	MOVE: "*** Move to: ",
	SECTION: "@@",
	END_FILE: "*** End of File",
} as const;

export const BASH_WRAPPERS = ["%%bash", "apply_patch", "EOF", "```"] as const;

export enum PatchActionType {
	ADD = "add",
	DELETE = "delete",
	UPDATE = "update",
}

export interface PatchChunk {
	origIndex: number;
	delLines: string[];
	insLines: string[];
}

export interface PatchAction {
	type: PatchActionType;
	newFile?: string;
	chunks: PatchChunk[];
	movePath?: string;
}

export interface PatchWarning {
	path: string;
	chunkIndex?: number;
	message: string;
	context?: string;
}

export interface Patch {
	actions: Record<string, PatchAction>;
	warnings?: PatchWarning[];
}

export class DiffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DiffError";
	}
}

function canonicalize(input: string): string {
	const punctuationMap: Record<string, string> = {
		"\u2010": "-",
		"\u2011": "-",
		"\u2012": "-",
		"\u2013": "-",
		"\u2014": "-",
		"\u2212": "-",
		"\u201C": '"',
		"\u201D": '"',
		"\u201E": '"',
		"\u00AB": '"',
		"\u00BB": '"',
		"\u2018": "'",
		"\u2019": "'",
		"\u201B": "'",
		"\u00A0": " ",
		"\u202F": " ",
	};
	return input
		.normalize("NFC")
		.replace(
			/[\u2010-\u2014\u2212\u2018\u2019\u201B\u201C-\u201E\u00AB\u00BB\u00A0\u202F]/g,
			(char) => punctuationMap[char] ?? char,
		)
		.replace(/\\`/g, "`")
		.replace(/\\'/g, "'")
		.replace(/\\"/g, '"');
}

export class PatchParser {
	private patch: Patch = { actions: {}, warnings: [] };
	private index = 0;
	private fuzz = 0;
	private currentPath?: string;
	private readonly matchingBudget = new MatchingBudget();

	constructor(
		private readonly lines: string[],
		private readonly currentFiles: Record<string, string>,
		private readonly signal?: AbortSignal,
	) {}

	parse(): { patch: Patch; fuzz: number } {
		throwIfAborted(this.signal);
		const steps = this.parseSteps();
		let step = steps.next();
		while (!step.done) {
			throwIfAborted(this.signal);
			step = steps.next();
		}
		throwIfAborted(this.signal);
		return step.value;
	}

	/** The filesystem executor yields between bounded parsing/matching batches. */
	async parseAsync(): Promise<{ patch: Patch; fuzz: number }> {
		let deadline = performance.now() + 8;
		throwIfAborted(this.signal);
		const steps = this.parseSteps();
		let step = steps.next();
		while (!step.done) {
			if (performance.now() >= deadline) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				throwIfAborted(this.signal);
				deadline = performance.now() + 8;
			}
			throwIfAborted(this.signal);
			step = steps.next();
		}
		throwIfAborted(this.signal);
		return step.value;
	}

	private *parseSteps(): Generator<void, { patch: Patch; fuzz: number }> {
		this.skipBeginSentinel();
		while (this.hasMoreLines() && !this.isEndMarker()) {
			yield* this.parseNextAction();
			yield;
		}
		if (this.patch.warnings?.length === 0) delete this.patch.warnings;
		return { patch: this.patch, fuzz: this.fuzz };
	}

	private addWarning(warning: PatchWarning): void {
		if (!this.patch.warnings) {
			this.patch.warnings = [];
		}
		this.patch.warnings.push(warning);
	}

	private skipBeginSentinel(): void {
		if (this.lines[this.index]?.startsWith(PATCH_MARKERS.BEGIN)) {
			this.index++;
		}
	}

	private hasMoreLines(): boolean {
		return this.index < this.lines.length;
	}

	private isEndMarker(): boolean {
		return this.lines[this.index]?.startsWith(PATCH_MARKERS.END) ?? false;
	}

	private *parseNextAction(): Generator<void> {
		const line = this.lines[this.index];
		if (line?.startsWith(PATCH_MARKERS.UPDATE)) {
			yield* this.parseUpdate(
				line.substring(PATCH_MARKERS.UPDATE.length).trim(),
			);
			return;
		}
		if (line?.startsWith(PATCH_MARKERS.DELETE)) {
			this.parseDelete(line.substring(PATCH_MARKERS.DELETE.length).trim());
			return;
		}
		if (line?.startsWith(PATCH_MARKERS.ADD)) {
			yield* this.parseAdd(line.substring(PATCH_MARKERS.ADD.length).trim());
			return;
		}
		throw new DiffError(`Unknown line while parsing: ${line}`);
	}

	private checkDuplicate(path: string, operation: string): void {
		if (path in this.patch.actions) {
			throw new DiffError(`Duplicate ${operation} for file: ${path}`);
		}
	}

	private *parseUpdate(path: string): Generator<void> {
		this.checkDuplicate(path, "update");
		this.currentPath = path;

		this.index++;
		const movePath = this.lines[this.index]?.startsWith(PATCH_MARKERS.MOVE)
			? (this.lines[this.index++] ?? "")
					.substring(PATCH_MARKERS.MOVE.length)
					.trim()
			: undefined;

		if (!(path in this.currentFiles)) {
			throw new DiffError(`Update File Error: Missing File: ${path}`);
		}

		const text = this.currentFiles[path] ?? "";
		const action = yield* this.parseUpdateFile(text, path);
		action.movePath = movePath;
		this.patch.actions[path] = action;
		this.currentPath = undefined;
	}

	private *parseUpdateFile(
		text: string,
		path: string,
	): Generator<void, PatchAction> {
		const action: PatchAction = { type: PatchActionType.UPDATE, chunks: [] };
		const fileLines = text.split("\n");
		const matcher = new ContextMatcher(fileLines, this.matchingBudget);
		let index = 0;

		const stopMarkers = [
			PATCH_MARKERS.END,
			PATCH_MARKERS.UPDATE,
			PATCH_MARKERS.DELETE,
			PATCH_MARKERS.ADD,
			PATCH_MARKERS.END_FILE,
		];

		while (
			!stopMarkers.some((marker) =>
				this.lines[this.index]?.startsWith(marker.trim()),
			)
		) {
			const currentLine = this.lines[this.index];
			const defStr = currentLine?.startsWith("@@ ")
				? currentLine.substring(3)
				: undefined;
			const sectionStr = currentLine === "@@" ? currentLine : undefined;

			if (defStr !== undefined || sectionStr !== undefined) {
				this.index++;
			} else if (index !== 0) {
				throw new DiffError(`Invalid Line:\n${this.lines[this.index]}`);
			}

			if (defStr?.trim()) {
				const canonDefStr = canonicalize(defStr.trim());
				for (let i = index; i < fileLines.length; i++) {
					if (i % 128 === 0) yield;
					const fileLine = fileLines[i];
					if (
						fileLine &&
						(canonicalize(fileLine) === canonDefStr ||
							canonicalize(fileLine.trim()) === canonDefStr)
					) {
						index = i + 1;
						if (
							canonicalize(fileLine.trim()) === canonDefStr &&
							canonicalize(fileLine) !== canonDefStr
						) {
							this.fuzz++;
						}
						break;
					}
				}
			}

			const [nextChunkContext, chunks, endPatchIndex, eof] = yield* peek(
				this.lines,
				this.index,
			);
			const [newIndex, fuzz, similarity] = yield* matcher.find(
				nextChunkContext,
				index,
				eof,
			);

			if (newIndex === -1) {
				const contextText = nextChunkContext.join("\n");
				this.addWarning({
					path: this.currentPath || path,
					chunkIndex: action.chunks.length,
					message: `Could not find matching context (similarity: ${similarity.toFixed(2)}). Chunk skipped.`,
					context:
						contextText.length > 200
							? `${contextText.substring(0, 200)}...`
							: contextText,
				});
				this.index = endPatchIndex;
			} else {
				this.fuzz += fuzz;
				for (const chunk of chunks) {
					chunk.origIndex += newIndex;
					action.chunks.push(chunk);
				}
				index = newIndex + nextChunkContext.length;
				this.index = endPatchIndex;
			}
			yield;
		}

		return action;
	}

	private parseDelete(path: string): void {
		this.checkDuplicate(path, "delete");
		if (!(path in this.currentFiles)) {
			throw new DiffError(`Delete File Error: Missing File: ${path}`);
		}
		this.patch.actions[path] = { type: PatchActionType.DELETE, chunks: [] };
		this.index++;
	}

	private *parseAdd(path: string): Generator<void> {
		this.checkDuplicate(path, "add");
		if (path in this.currentFiles) {
			throw new DiffError(`Add File Error: File already exists: ${path}`);
		}

		this.index++;
		const lines: string[] = [];
		const stopMarkers = [
			PATCH_MARKERS.END,
			PATCH_MARKERS.UPDATE,
			PATCH_MARKERS.DELETE,
			PATCH_MARKERS.ADD,
		];

		while (
			this.hasMoreLines() &&
			!stopMarkers.some((marker) =>
				this.lines[this.index]?.startsWith(marker.trim()),
			)
		) {
			if (this.index % 128 === 0) yield;
			const line = this.lines[this.index++];
			if (line === undefined) {
				break;
			}
			if (!line.startsWith("+")) {
				throw new DiffError(`Invalid Add File line (missing '+'): ${line}`);
			}
			lines.push(line.substring(1));
		}

		this.patch.actions[path] = {
			type: PatchActionType.ADD,
			newFile: lines.join("\n"),
			chunks: [],
		};
	}
}

// Shared by all files/hunks in a patch. Count matching time, excluding time
// spent awaiting the scheduler, and check at every generator checkpoint.
export const PATCH_MATCHING_TIMEOUT_MS = 30_000;

class MatchingBudget {
	remaining = PATCH_MATCHING_TIMEOUT_MS;
}

/** Banded Levenshtein over UTF-16 code units, as in the legacy implementation.
 * Returns an exact distance within the bound, or bound + 1 otherwise.
 * Generator checkpoints also bound uninterrupted work inside a single comparison.
 */
function* boundedDistance(
	a: string,
	b: string,
	limit: number,
): Generator<void, number> {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	const width = Math.min(a.length + 1, 2 * limit + 3);
	let previous = new Float64Array(width);
	let current = new Float64Array(width);
	let previousStart = 0;
	let previousEnd = Math.min(a.length, limit);
	for (let j = 0; j <= previousEnd; j++) previous[j] = j;
	let batch = 0;
	for (let i = 1; i <= b.length; i++) {
		const start = Math.max(0, i - limit);
		const end = Math.min(a.length, i + limit);
		let minimum = limit + 1;
		for (let j = start; j <= end; j++) {
			const above =
				j >= previousStart && j <= previousEnd
					? previous[j - previousStart]
					: limit + 1;
			const diagonal =
				j - 1 >= previousStart && j - 1 <= previousEnd
					? previous[j - 1 - previousStart]
					: limit + 1;
			const left = j > start ? current[j - 1 - start] : limit + 1;
			const value =
				j === 0
					? i
					: Math.min(
							above + 1,
							left + 1,
							diagonal + (a.charCodeAt(j - 1) === b.charCodeAt(i - 1) ? 0 : 1),
						);
			current[j - start] = value;
			minimum = Math.min(minimum, value);
			if (++batch === 16_384) {
				batch = 0;
				yield;
			}
		}
		if (minimum > limit) {
			return limit + 1;
		}
		[previous, current] = [current, previous];
		previousStart = start;
		previousEnd = end;
	}
	return previous[a.length - previousStart];
}

function* calculateSimilarity(a: string, b: string): Generator<void, number> {
	const longer = Math.max(a.length, b.length);
	if (longer === 0 || a === b) return 1;
	// Use the legacy floating-point comparison at the threshold, including its
	// rounding behavior for lengths whose allowed distance is an integer.
	let maximum = Math.floor(longer * 0.34);
	while ((longer - maximum) / longer < 0.66) maximum--;
	while ((longer - maximum - 1) / longer >= 0.66) maximum++;
	if (Math.abs(a.length - b.length) > maximum) return 0;

	// Equal prefixes/suffixes cannot affect Levenshtein distance. This makes a
	// one-character edit in a long context cheap without changing its score.
	let start = 0;
	let aEnd = a.length;
	let bEnd = b.length;
	while (
		start < aEnd &&
		start < bEnd &&
		a.charCodeAt(start) === b.charCodeAt(start)
	) {
		if (++start % 16_384 === 0) yield;
	}
	while (
		aEnd > start &&
		bEnd > start &&
		a.charCodeAt(aEnd - 1) === b.charCodeAt(bEnd - 1)
	) {
		aEnd--;
		bEnd--;
		if (aEnd % 16_384 === 0) yield;
	}
	a = a.slice(start, aEnd);
	b = b.slice(start, bEnd);
	if (a.length === 0 || b.length === 0) {
		return (longer - Math.max(a.length, b.length)) / longer;
	}
	// A character-frequency lower bound cheaply rejects disjoint
	// inputs. One edit can remove at most one surplus code unit on either side.
	{
		const counts = new Map<number, number>();
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			if (i < a.length)
				counts.set(a.charCodeAt(i), (counts.get(a.charCodeAt(i)) ?? 0) + 1);
			if (i < b.length)
				counts.set(b.charCodeAt(i), (counts.get(b.charCodeAt(i)) ?? 0) - 1);
			if (i % 16_384 === 0) yield;
		}
		let positive = 0;
		let negative = 0;
		for (const count of counts.values()) {
			if (count > 0) positive += count;
			else negative -= count;
		}
		if (Math.max(positive, negative) > maximum) return 0;
	}
	// Try a tiny band for close matches, then use word-parallel exact DP for
	// ordinary dense comparisons. This still computes the joined-string metric.
	const narrow = Math.min(maximum, Math.max(1, Math.abs(a.length - b.length)));
	const closeDistance = yield* boundedDistance(a, b, narrow);
	if (closeDistance <= narrow) return (longer - closeDistance) / longer;
	if (Math.min(a.length, b.length) <= 32_000) {
		const [distance] = yield* substringDistanceBounds(
			a.length <= b.length ? [b] : [a],
			a.length <= b.length ? a : b,
			false,
		);
		return distance <= maximum ? (longer - distance) / longer : 0;
	}
	// Start narrow so close matches cost O(n * distance), then widen only when
	// needed, up to exactly the old acceptance threshold.
	let limit = Math.min(maximum, Math.max(1, Math.abs(a.length - b.length)));
	while (true) {
		const distance = yield* boundedDistance(a, b, limit);
		if (distance <= limit) return (longer - distance) / longer;
		if (limit === maximum) return 0;
		limit = Math.min(maximum, limit * 2);
	}
}

/** Myers bit-vector DP with a free starting offset. At each line end this
 * returns the distance to the closest substring ending there. The candidate
 * window is one such substring, so this is a lower bound on its full UTF-16
 * Levenshtein distance. Rejecting only above the legacy threshold cannot skip
 * a valid candidate. No per-line decomposition of the distance is assumed.
 */
function* substringDistanceBounds(
	lines: string[],
	context: string,
	freeStart = true,
): Generator<void, number[]> {
	const width = Math.ceil(context.length / 32);
	const masks = new Map<number, Uint32Array>();
	for (let i = 0; i < context.length; i++) {
		const code = context.charCodeAt(i);
		let mask = masks.get(code);
		if (!mask) {
			mask = new Uint32Array(width);
			masks.set(code, mask);
		}
		mask[i >>> 5] |= 1 << (i & 31);
		if (i % 16_384 === 0) yield;
	}
	const high = 1 << ((context.length - 1) & 31);
	const positive = new Uint32Array(width).fill(0xffffffff);
	const negative = new Uint32Array(width);
	let distance = context.length;
	const bounds: number[] = [];
	let batch = 0;
	for (const line of lines) {
		// Include separators before each line, so the saved endpoint excludes
		// the trailing newline, just like slice(...).join("\n").
		const text = bounds.length ? `\n${line}` : line;
		for (let i = 0; i < text.length; i++) {
			const mask = masks.get(text.charCodeAt(i));
			// Row zero is free for substring matching, or global for exact scores.
			let incoming = freeStart ? 0 : 1;
			for (let word = 0; word < width; word++) {
				let equal = mask?.[word] ?? 0;
				const pv = positive[word];
				const mv = negative[word];
				const vertical = equal | mv;
				if (incoming < 0) equal |= 1;
				const horizontal = (((equal & pv) + pv) ^ pv) | equal;
				let plus = mv | ~(horizontal | pv);
				let minus = pv & horizontal;
				if (word === width - 1) {
					if (plus & high) distance++;
					if (minus & high) distance--;
				}
				const outgoing = (plus >>> 31) - (minus >>> 31);
				plus = (plus << 1) | (incoming > 0 ? 1 : 0);
				minus = (minus << 1) | (incoming < 0 ? 1 : 0);
				positive[word] = minus | ~(vertical | plus);
				negative[word] = plus & vertical;
				incoming = outgoing;
				if (++batch === 16_384) {
					batch = 0;
					yield;
				}
			}
		}
		bounds.push(distance);
	}
	return bounds;
}

type ContextResult = [number, number, number];

class ContextMatcher {
	private readonly cached: string[][];

	constructor(
		private readonly lines: string[],
		private readonly budget: MatchingBudget,
	) {
		this.cached = Array.from(
			{ length: 3 },
			() => new Array<string>(lines.length),
		);
	}

	private line(index: number, mode: number): string {
		return (this.cached[mode][index] ??= canonicalize(
			mode === 1
				? this.lines[index].trimEnd()
				: mode === 2
					? this.lines[index].trim()
					: this.lines[index],
		));
	}

	// KMP over canonical lines avoids building and comparing a full sliding window
	// at every offset. Cached file lines are reused by all hunks in the same file.
	private *exact(
		context: string[],
		start: number,
		mode: number,
	): Generator<void, number> {
		// Legacy EOF searches can begin before zero when the hunk is longer
		// than the file. Preserve Array.slice's negative-offset behavior.
		const canonicalContext = canonicalize(
			context
				.map((line) =>
					mode === 1 ? line.trimEnd() : mode === 2 ? line.trim() : line,
				)
				.join("\n"),
		);
		for (let i = start; i < 0; i++) {
			const segment = canonicalize(
				this.lines
					.slice(i, i + context.length)
					.map((line) =>
						mode === 1 ? line.trimEnd() : mode === 2 ? line.trim() : line,
					)
					.join("\n"),
			);
			if (segment === canonicalContext) return i;
			yield;
		}
		const pattern: string[] = [];
		for (let i = 0; i < context.length; i++) {
			pattern.push(
				canonicalize(
					mode === 1
						? context[i].trimEnd()
						: mode === 2
							? context[i].trim()
							: context[i],
				),
			);
			if (i % 128 === 0) yield;
		}
		const failure = new Array<number>(pattern.length).fill(0);
		for (let i = 1, j = 0; i < pattern.length; i++) {
			while (j > 0 && pattern[i] !== pattern[j]) j = failure[j - 1];
			if (pattern[i] === pattern[j]) j++;
			failure[i] = j;
			if (i % 128 === 0) yield;
		}
		for (let i = Math.max(0, start), j = 0; i < this.lines.length; i++) {
			const line = this.line(i, mode);
			while (j > 0 && line !== pattern[j]) j = failure[j - 1];
			if (line === pattern[j]) j++;
			if (j === pattern.length) return i - j + 1;
			if (i % 128 === 0) yield;
		}
		return -1;
	}

	private *findCore(
		context: string[],
		start: number,
	): Generator<void, ContextResult> {
		for (const [mode, fuzz] of [
			[0, 0],
			[1, 1],
			[2, 100],
		]) {
			const index = yield* this.exact(context, start, mode);
			if (index !== -1) return [index, fuzz, 1];
		}
		const canonicalContext = canonicalize(context.join("\n"));
		// Keep bit vectors bounded for huge single-line/multi-MB hunks. For
		// ordinary long hunks this shared DP avoids expensive rejected windows.
		const boundsStart = Math.max(0, start);
		const bounds =
			canonicalContext.length >= 256 && canonicalContext.length <= 32_000
				? yield* substringDistanceBounds(
						this.lines
							.slice(boundsStart)
							.map((_, i) => this.line(i + boundsStart, 0)),
						canonicalContext,
					)
				: undefined;
		let bestSimilarity = 0;
		for (let i = start; i < this.lines.length; i++) {
			const segment = canonicalize(
				this.lines.slice(i, i + context.length).join("\n"),
			);
			const lowerBound =
				i >= 0
					? bounds?.[
							Math.min(i + context.length, this.lines.length) - 1 - boundsStart
						]
					: undefined;
			if (
				lowerBound !== undefined &&
				(Math.max(segment.length, canonicalContext.length) - lowerBound) /
					Math.max(segment.length, canonicalContext.length) <
					0.66
			) {
				yield;
				continue;
			}
			const similarity = yield* calculateSimilarity(segment, canonicalContext);
			if (similarity >= 0.66) return [i, 1000, similarity];
			bestSimilarity = Math.max(bestSimilarity, similarity);
			yield;
		}
		return [-1, 0, bestSimilarity];
	}

	*find(
		context: string[],
		start: number,
		eof: boolean,
	): Generator<void, ContextResult> {
		const steps = this.findSteps(context, start, eof);
		while (true) {
			const before = performance.now();
			const step = steps.next();
			this.budget.remaining -= performance.now() - before;
			if (this.budget.remaining < 0) {
				throw new DiffError(
					"Patch context exceeds the pathological fuzzy matching safety limit. Re-read and retry with smaller hunks. No files were changed.",
				);
			}
			if (step.done) return step.value;
			yield;
		}
	}

	private *findSteps(
		context: string[],
		start: number,
		eof: boolean,
	): Generator<void, ContextResult> {
		if (context.length === 0) return [start, 0, 1];
		if (eof) {
			const end = this.lines.length - context.length;
			const result = yield* this.findCore(context, end);
			if (result[0] !== -1) return result;
			const fallback = yield* this.findCore(context, start);
			return [fallback[0], fallback[1] + 10000, fallback[2]];
		}
		return yield* this.findCore(context, start);
	}
}

type PeekResult = [string[], PatchChunk[], number, boolean];

function* peek(
	lines: string[],
	initialIndex: number,
): Generator<void, PeekResult> {
	let index = initialIndex;
	const old: string[] = [];
	let delLines: string[] = [];
	let insLines: string[] = [];
	const chunks: PatchChunk[] = [];
	let mode: "keep" | "add" | "delete" = "keep";

	const stopMarkers = [
		"@@",
		PATCH_MARKERS.END,
		PATCH_MARKERS.UPDATE,
		PATCH_MARKERS.DELETE,
		PATCH_MARKERS.ADD,
		PATCH_MARKERS.END_FILE,
	];

	while (index < lines.length) {
		if (index % 128 === 0) yield;
		const sourceLine = lines[index];
		if (
			!sourceLine ||
			stopMarkers.some((marker) => sourceLine.startsWith(marker.trim()))
		) {
			break;
		}
		if (sourceLine === "***") {
			break;
		}
		if (sourceLine.startsWith("***")) {
			throw new DiffError(`Invalid line: ${sourceLine}`);
		}

		index++;
		const previousMode: "keep" | "add" | "delete" = mode;
		let line = sourceLine;

		if (line[0] === "+") {
			mode = "add";
		} else if (line[0] === "-") {
			mode = "delete";
		} else if (line[0] === " ") {
			mode = "keep";
		} else {
			mode = "keep";
			line = ` ${line}`;
		}

		line = line.slice(1);

		if (mode === "keep" && previousMode !== mode) {
			if (insLines.length || delLines.length) {
				chunks.push({
					origIndex: old.length - delLines.length,
					delLines,
					insLines,
				});
			}
			delLines = [];
			insLines = [];
		}

		if (mode === "delete") {
			delLines.push(line);
			old.push(line);
		} else if (mode === "add") {
			insLines.push(line);
		} else {
			old.push(line);
		}
	}

	if (insLines.length || delLines.length) {
		chunks.push({
			origIndex: old.length - delLines.length,
			delLines,
			insLines,
		});
	}

	if (index < lines.length && lines[index] === PATCH_MARKERS.END_FILE) {
		index++;
		return [old, chunks, index, true];
	}

	return [old, chunks, index, false];
}
