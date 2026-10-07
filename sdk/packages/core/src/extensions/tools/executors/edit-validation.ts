import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new DOMException("Patch application was cancelled.", "AbortError");
	}
}

export function contentHash(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export function fileSnapshot(filePath: string): string | undefined {
	try {
		return contentHash(readFileSync(filePath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function validateSnapshot(
	filePath: string,
	snapshot: string | undefined,
): void {
	if (fileSnapshot(filePath) !== snapshot) {
		throw staleFileError(filePath);
	}
}

export function staleFileError(filePath: string): Error {
	return new Error(
		`${filePath}: file changed during patch application; re-read and retry`,
	);
}

/** Exclusive creation closes the absence-check/create race. */
export function createFileExclusive(
	filePath: string,
	content: string,
	encoding: BufferEncoding,
): void {
	try {
		writeFileSync(filePath, content, { encoding, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw staleFileError(filePath);
		throw error;
	}
}
