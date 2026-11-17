/**
 * Apply Patch Executor
 *
 * Built-in implementation for the documented GPT-5 apply_patch grammar.
 * It accepts the freeform patch body directly and tolerates the legacy shell
 * wrapper form used by older prompts.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import type { ApplyPatchInput } from "../schemas";
import type { ApplyPatchExecutor } from "../types";
import {
	BASH_WRAPPERS,
	DiffError,
	PATCH_MARKERS,
	PatchActionType,
	type PatchChunk,
	PatchParser,
	type PatchWarning,
} from "./apply-patch-parser";
import {
	contentHash,
	createFileExclusive,
	throwIfAborted,
	validateSnapshot,
} from "./edit-validation";
import {
	detectLineEnding,
	type LineEnding,
	normalizeLineEndings,
	normalizeNewFileLineEndings,
} from "./line-endings";

export interface PatchFileChange {
	type: PatchActionType;
	oldContent?: string;
	newContent?: string;
	movePath?: string;
}

interface NormalizedPatchInput {
	lines: string[];
}

/**
 * Options for the apply_patch executor
 */
export interface ApplyPatchExecutorOptions {
	/**
	 * File encoding used for read/write operations
	 * @default "utf-8"
	 */
	encoding?: BufferEncoding;

	/** Cancel parsing/matching before any filesystem mutation. */
	signal?: AbortSignal;

	/**
	 * Restrict relative-path file operations to paths inside cwd.
	 * Absolute paths are always accepted as-is.
	 * @default true
	 */
	restrictToCwd?: boolean;
}

function resolveFilePath(
	cwd: string,
	inputPath: string,
	restrictToCwd: boolean,
): string {
	const isAbsoluteInput = path.isAbsolute(inputPath);
	const resolved = isAbsoluteInput
		? path.normalize(inputPath)
		: path.resolve(cwd, inputPath);
	if (!restrictToCwd || isAbsoluteInput) {
		return resolved;
	}

	const rel = path.relative(cwd, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new DiffError(`Path must stay within cwd: ${inputPath}`);
	}
	return resolved;
}

function splitPatchInputLines(input: string): string[] {
	return input.split("\n").map((line) => line.replace(/\r$/, ""));
}

function isWrapperLine(line: string): boolean {
	if (line.trim() === "") {
		return false;
	}
	return BASH_WRAPPERS.some((wrapper) => line.startsWith(wrapper));
}

function trimWrapperLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && isWrapperLine(lines[start] ?? "")) {
		start++;
	}

	while (end > start && isWrapperLine(lines[end - 1] ?? "")) {
		end--;
	}

	return lines.slice(start, end);
}

function normalizePatchInput(input: string): NormalizedPatchInput {
	const rawLines = splitPatchInputLines(input);
	const beginIndex = rawLines.findIndex((line) =>
		line.startsWith(PATCH_MARKERS.BEGIN),
	);
	let endIndex = -1;
	for (let i = rawLines.length - 1; i >= 0; i--) {
		if (rawLines[i]?.startsWith(PATCH_MARKERS.END)) {
			endIndex = i;
			break;
		}
	}

	if (beginIndex !== -1 || endIndex !== -1) {
		if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
			throw new DiffError(
				"Invalid patch text - incomplete sentinels. Try breaking it into smaller patches.",
			);
		}
		const lines = rawLines.slice(beginIndex, endIndex + 1);
		return {
			lines,
		};
	}

	const stripped = trimWrapperLines(rawLines);
	while (stripped.length > 0 && stripped[0] === "") {
		stripped.shift();
	}
	while (stripped.length > 0 && stripped[stripped.length - 1] === "") {
		stripped.pop();
	}

	const lines = [PATCH_MARKERS.BEGIN, ...stripped, PATCH_MARKERS.END];
	return {
		lines,
	};
}

function extractFilesForOperations(
	lines: readonly string[],
	markers: readonly string[],
): string[] {
	const files = new Set<string>();

	for (const line of lines) {
		for (const marker of markers) {
			if (line.startsWith(marker)) {
				files.add(line.substring(marker.length).trim());
				break;
			}
		}
	}

	return [...files];
}

function applyChunks(
	content: string,
	chunks: PatchChunk[],
	filePath: string,
): string {
	if (chunks.length === 0) {
		return content;
	}

	const lines = content.split("\n");
	const result: string[] = [];
	let currentIndex = 0;

	for (const chunk of chunks) {
		if (chunk.origIndex > lines.length) {
			throw new DiffError(
				`${filePath}: chunk.origIndex ${chunk.origIndex} > lines.length ${lines.length}`,
			);
		}
		if (currentIndex > chunk.origIndex) {
			throw new DiffError(
				`${filePath}: currentIndex ${currentIndex} > chunk.origIndex ${chunk.origIndex}`,
			);
		}
		for (let i = currentIndex; i < chunk.origIndex; i++) result.push(lines[i]);
		for (const line of chunk.insLines) result.push(line);
		currentIndex = chunk.origIndex + chunk.delLines.length;
	}

	for (let i = currentIndex; i < lines.length; i++) result.push(lines[i]);
	return result.join("\n");
}

interface LoadedFiles {
	/**
	 * File contents normalized to LF. The parser and chunk math work in LF
	 * space because models emit LF-only patch text even for CRLF files.
	 */
	files: Record<string, string>;
	/** Each file's own EOL, restored onto the output after chunks apply. */
	eols: Record<string, LineEnding>;
	snapshots: Record<string, string | undefined>;
}

async function loadFiles(
	lines: readonly string[],
	cwd: string,
	encoding: BufferEncoding,
	restrictToCwd: boolean,
	signal?: AbortSignal,
): Promise<LoadedFiles> {
	const filesToLoad = extractFilesForOperations(lines, [
		PATCH_MARKERS.UPDATE,
		PATCH_MARKERS.DELETE,
	]);
	const files: Record<string, string> = {};
	const eols: Record<string, LineEnding> = {};
	const snapshots: Record<string, string | undefined> = {};
	throwIfAborted(signal);

	for (const filePath of filesToLoad) {
		const absolutePath = resolveFilePath(cwd, filePath, restrictToCwd);
		let fileContent: string;
		try {
			const bytes = await fs.readFile(absolutePath);
			throwIfAborted(signal);
			if (!(absolutePath in snapshots))
				snapshots[absolutePath] = contentHash(bytes);
			fileContent = bytes.toString(encoding);
		} catch {
			throwIfAborted(signal);
			throw new DiffError(`File not found: ${filePath}`);
		}
		files[filePath] = fileContent.replace(/\r\n/g, "\n");
		eols[filePath] = detectLineEnding(fileContent);
	}

	const addPaths = new Set(
		extractFilesForOperations(lines, [PATCH_MARKERS.ADD]),
	);
	// Snapshot both new-file and move destinations, including their absence.
	for (const filePath of extractFilesForOperations(lines, [
		PATCH_MARKERS.ADD,
		PATCH_MARKERS.MOVE,
	])) {
		const absolutePath = resolveFilePath(cwd, filePath, restrictToCwd);
		try {
			const bytes = await fs.readFile(absolutePath);
			throwIfAborted(signal);
			if (!(absolutePath in snapshots))
				snapshots[absolutePath] = contentHash(bytes);
			if (addPaths.has(filePath)) files[filePath] = bytes.toString(encoding);
		} catch (error) {
			throwIfAborted(signal);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!(absolutePath in snapshots)) snapshots[absolutePath] = undefined;
		}
	}
	return { files, eols, snapshots };
}

function patchToChanges(
	patch: ReturnType<PatchParser["parse"]>["patch"],
	loaded: LoadedFiles,
): Record<string, PatchFileChange> {
	const changes: Record<string, PatchFileChange> = {};
	const originalFiles = loaded.files;
	// Chunk math ran in LF space; restore each file's own EOL on the way out
	// so an UPDATE never rewrites a CRLF file to LF wholesale.
	const withFileEol = (
		filePath: string,
		content: string | undefined,
	): string | undefined =>
		content === undefined
			? undefined
			: normalizeLineEndings(content, loaded.eols[filePath] ?? "\n");

	for (const [filePath, action] of Object.entries(patch.actions)) {
		switch (action.type) {
			case PatchActionType.DELETE:
				changes[filePath] = {
					type: PatchActionType.DELETE,
					oldContent: withFileEol(filePath, originalFiles[filePath]),
				};
				break;
			case PatchActionType.ADD:
				if (action.newFile === undefined) {
					throw new DiffError("ADD action without file content");
				}
				changes[filePath] = {
					type: PatchActionType.ADD,
					newContent: normalizeNewFileLineEndings(action.newFile),
				};
				break;
			case PatchActionType.UPDATE:
				changes[filePath] = {
					type: PatchActionType.UPDATE,
					oldContent: withFileEol(filePath, originalFiles[filePath]),
					newContent: withFileEol(
						filePath,
						applyChunks(originalFiles[filePath] ?? "", action.chunks, filePath),
					),
					movePath: action.movePath,
				};
				break;
		}
	}

	return changes;
}

function formatSkippedHunkFailure(warnings: readonly PatchWarning[]): string {
	const lines = [
		`Patch could not be applied because ${warnings.length} hunk${warnings.length === 1 ? "" : "s"} did not match the current file content.`,
	];

	for (const warning of warnings) {
		const hunkNumber =
			warning.chunkIndex === undefined
				? "unknown"
				: String(warning.chunkIndex + 1);
		lines.push(`${warning.path}: hunk ${hunkNumber}: ${warning.message}`);
		if (warning.context) {
			lines.push(`Context:\n${warning.context}`);
		}
	}

	return lines.join("\n");
}

function applyChanges(
	changes: Record<string, PatchFileChange>,
	cwd: string,
	encoding: BufferEncoding,
	restrictToCwd: boolean,
	snapshots: Record<string, string | undefined>,
	signal?: AbortSignal,
): string[] {
	throwIfAborted(signal);
	// Preserve the up-front validation, then narrow the external-process race
	// with another check immediately before each mutation. General filesystems
	// cannot atomically compare contents and replace/delete an existing file.
	for (const [filePath, snapshot] of Object.entries(snapshots)) {
		validateSnapshot(filePath, snapshot);
	}
	throwIfAborted(signal);
	const touched: string[] = [];
	const expected = { ...snapshots };
	const operations: {
		filePath: string;
		absolutePath: string;
		content?: string;
		sourcePath?: string;
	}[] = [];
	for (const [filePath, change] of Object.entries(changes)) {
		const sourceAbsPath = resolveFilePath(cwd, filePath, restrictToCwd);
		if (
			change.type !== PatchActionType.DELETE &&
			change.newContent === undefined
		) {
			throw new DiffError(`Cannot write ${filePath} with no content`);
		}
		if (change.movePath) {
			operations.push({
				filePath: change.movePath,
				absolutePath: resolveFilePath(cwd, change.movePath, restrictToCwd),
				content: change.newContent,
				sourcePath: sourceAbsPath,
			});
		}
		operations.push({
			filePath,
			absolutePath: sourceAbsPath,
			content:
				change.movePath || change.type === PatchActionType.DELETE
					? undefined
					: change.newContent,
		});
	}
	const completed: string[] = [];
	const describeOperation = (operation: (typeof operations)[number]) =>
		`${operation.filePath}: ${operation.content === undefined ? "deleted" : "written"}`;
	try {
		for (const operation of operations) {
			const { absolutePath, content } = operation;
			if (content === undefined) {
				validateSnapshot(absolutePath, expected[absolutePath]);
				fsSync.rmSync(absolutePath, { force: true });
				expected[absolutePath] = undefined;
			} else {
				fsSync.mkdirSync(path.dirname(absolutePath), { recursive: true });
				// A move must still have its original source before writing its
				// destination, and gets another source check before the deletion.
				if (operation.sourcePath)
					validateSnapshot(
						operation.sourcePath,
						expected[operation.sourcePath],
					);
				validateSnapshot(absolutePath, expected[absolutePath]);
				if (expected[absolutePath] === undefined) {
					createFileExclusive(absolutePath, content, encoding);
				} else {
					fsSync.writeFileSync(absolutePath, content, { encoding });
				}
				expected[absolutePath] = contentHash(Buffer.from(content, encoding));
			}
			completed.push(describeOperation(operation));
		}
	} catch (error) {
		throw new Error(
			[
				error instanceof Error ? error.message : String(error),
				"Patch stopped before all operations completed.",
				`Completed file operations:\n${completed.join("\n") || "(none)"}`,
				`File operations not completed:\n${operations.slice(completed.length).map(describeOperation).join("\n")}`,
			].join("\n"),
			{ cause: error },
		);
	}
	for (const [filePath, change] of Object.entries(changes)) {
		touched.push(
			change.movePath
				? `${filePath} -> ${change.movePath}`
				: change.type === PatchActionType.DELETE
					? `${filePath}: [deleted]`
					: filePath,
		);
	}

	return touched;
}

/**
 * Parse a patch and compute the per-file changes it would apply, without
 * writing anything to disk. Reads the current contents of the files the patch
 * references. Exposed so hosts can preview a patch (e.g. in a diff editor)
 * before the executor applies it.
 */
async function preparePatchChanges(
	patchText: string,
	cwd: string,
	options: ApplyPatchExecutorOptions = {},
): Promise<{
	changes: Record<string, PatchFileChange>;
	fuzz: number;
	snapshots: Record<string, string | undefined>;
}> {
	const { encoding = "utf-8", restrictToCwd = true, signal } = options;
	const normalizedInput = normalizePatchInput(patchText);
	const loaded = await loadFiles(
		normalizedInput.lines,
		cwd,
		encoding,
		restrictToCwd,
		signal,
	);
	const parser = new PatchParser(normalizedInput.lines, loaded.files, signal);
	const { patch, fuzz } = await parser.parseAsync();
	if (patch.warnings && patch.warnings.length > 0) {
		throw new DiffError(formatSkippedHunkFailure(patch.warnings));
	}

	throwIfAborted(signal);
	return {
		changes: patchToChanges(patch, loaded),
		fuzz,
		snapshots: loaded.snapshots,
	};
}

export async function computePatchChanges(
	patchText: string,
	cwd: string,
	options: ApplyPatchExecutorOptions = {},
): Promise<{ changes: Record<string, PatchFileChange>; fuzz: number }> {
	const { changes, fuzz } = await preparePatchChanges(patchText, cwd, options);
	return { changes, fuzz };
}

/**
 * Create an apply_patch executor using Node.js fs module.
 */
export function createApplyPatchExecutor(
	options: ApplyPatchExecutorOptions = {},
): ApplyPatchExecutor {
	const { encoding = "utf-8", restrictToCwd = true, signal } = options;

	return async (
		input: ApplyPatchInput,
		cwd: string,
		context: AgentToolContext,
	): Promise<string> => {
		const patchSignal = context.signal ?? signal;
		const { changes, fuzz, snapshots } = await preparePatchChanges(
			input.input,
			cwd,
			{
				encoding,
				restrictToCwd,
				signal: patchSignal,
			},
		);
		const touched = applyChanges(
			changes,
			cwd,
			encoding,
			restrictToCwd,
			snapshots,
			patchSignal,
		);

		const responseLines = [
			"Successfully applied patch to the following files:",
		];
		for (const file of touched) {
			responseLines.push(file);
		}
		if (fuzz > 0) {
			responseLines.push(`Note: Patch applied with fuzz factor ${fuzz}`);
		}
		return responseLines.join("\n");
	};
}
