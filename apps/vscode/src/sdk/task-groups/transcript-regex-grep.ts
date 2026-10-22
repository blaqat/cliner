import { Worker } from "node:worker_threads"
import { TRANSCRIPT_GREP_MAX_HITS, type TranscriptEntry } from "./thread-transcript"

export const REGEX_GREP_TIMEOUT_MS = 2_000

export interface RegexGrepGroup {
	entries: readonly Pick<TranscriptEntry, "index" | "role" | "text">[]
}

export interface RegexGrepHit {
	/** Position of the group (thread) in the input list. */
	group: number
	index: number
	role: string
	line: string
}

export type RegexGrepResult = { ok: true; hits: RegexGrepHit[] } | { ok: false; reason: "timeout" | "error"; message: string }

// Inline source (`eval: true`) so the worker needs no separate file in the bundled extension.
// Mirrors grepTranscript: line by line, trimmed hits, shared hit cap across groups.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads")
try {
	const { pattern, groups, maxHits } = workerData
	const regex = new RegExp(pattern, "i")
	const hits = []
	outer: for (let group = 0; group < groups.length; group++) {
		for (const entry of groups[group]) {
			for (const line of entry.text.split("\\n")) {
				if (hits.length >= maxHits) break outer
				if (regex.test(line)) hits.push({ group, index: entry.index, role: entry.role, line: line.trim() })
			}
		}
	}
	parentPort.postMessage({ ok: true, hits })
} catch (error) {
	parentPort.postMessage({ ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) })
}
`

/**
 * Runs an agent-supplied regex over transcript text in a worker thread that is
 * terminated after `timeoutMs`. A catastrophically backtracking pattern can
 * block a thread forever; keeping it off the extension host thread (and killing
 * it) is the only way to bound it.
 */
export function runRegexGrep(
	pattern: string,
	groups: readonly RegexGrepGroup[],
	options: { maxHits?: number; timeoutMs?: number } = {},
): Promise<RegexGrepResult> {
	const timeoutMs = options.timeoutMs ?? REGEX_GREP_TIMEOUT_MS
	return new Promise((resolve) => {
		let settled = false
		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: {
				pattern,
				maxHits: options.maxHits ?? TRANSCRIPT_GREP_MAX_HITS,
				groups: groups.map((group) =>
					group.entries.map((entry) => ({ index: entry.index, role: entry.role, text: entry.text })),
				),
			},
			resourceLimits: { maxOldGenerationSizeMb: 256 },
		})
		const finish = (result: RegexGrepResult) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			void worker.terminate()
			resolve(result)
		}
		const timer = setTimeout(
			() =>
				finish({
					ok: false,
					reason: "timeout",
					message: `The regex search took longer than ${timeoutMs / 1000}s and was stopped.`,
				}),
			timeoutMs,
		)
		worker.once("message", (result: RegexGrepResult) => finish(result))
		worker.once("error", (error) => finish({ ok: false, reason: "error", message: error.message }))
		worker.once("exit", () => finish({ ok: false, reason: "error", message: "The regex search worker exited unexpectedly." }))
	})
}
