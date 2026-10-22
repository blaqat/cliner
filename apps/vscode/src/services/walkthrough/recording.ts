import path from "node:path"
import { type ApplyPatchInput, computePatchChanges, type EditFileInput } from "@cline/core"
import type { AgentToolContext } from "@cline/shared"
import { readDisk, recordEdits } from "./collection"

/** Capture actual disk writes, including partial patch failures, without changing executor results. */
export async function recordToolEdits(
	directory: () => Promise<string | undefined>,
	input: EditFileInput | ApplyPatchInput,
	cwd: string,
	context: AgentToolContext,
	execute: () => Promise<string>,
	onError: (error: unknown) => void,
): Promise<string> {
	const paths = new Set<string>()
	try {
		if ("input" in input) {
			const { changes } = await computePatchChanges(input.input, cwd)
			for (const [file, change] of Object.entries(changes)) {
				paths.add(path.resolve(cwd, file))
				if (change.movePath) paths.add(path.resolve(cwd, change.movePath))
			}
		} else paths.add(path.resolve(cwd, input.path))
	} catch (error) {
		onError(error)
	}
	const before = new Map<string, Awaited<ReturnType<typeof readDisk>>>()
	for (const file of paths) {
		try {
			before.set(file, await readDisk(file))
		} catch (error) {
			onError(error)
		}
	}
	try {
		return await execute()
	} finally {
		try {
			const edits = []
			for (const [filePath, old] of before) {
				const after = await readDisk(filePath)
				if (old.text === after.text && old.exists === after.exists) continue
				edits.push({
					filePath,
					before: old.text,
					after: after.text,
					beforeExists: old.exists,
					afterExists: after.exists,
					toolCallId: context.toolCallId ?? "",
					runId: context.runId ?? "",
				})
			}
			const dir = edits.length ? await directory() : undefined
			if (dir) await recordEdits(dir, edits)
		} catch (error) {
			onError(error)
		}
	}
}
