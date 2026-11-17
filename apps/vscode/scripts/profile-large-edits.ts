// Build with Bun for Node, then run with node --cpu-prof. No VS Code host or credentials needed.
// From the repo root:
// bun build apps/vscode/scripts/profile-large-edits.ts --target=node --outfile=tmp/large-edit-profile/host.mjs
// node --cpu-prof --cpu-prof-dir=tmp/large-edit-profile tmp/large-edit-profile/host.mjs --large
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import {
	computePatchChanges,
	createApplyPatchExecutor,
} from "../../../sdk/packages/core/src/extensions/tools/executors/apply-patch"
import { createEditorExecutor } from "../../../sdk/packages/core/src/extensions/tools/executors/editor"
import { buildEditPreviewAnimation } from "../src/integrations/editor/EditPreview"

const large = process.argv.includes("--large")
const cwd = await mkdtemp(join(tmpdir(), "cline-large-edit-profile-"))
async function measure(name: string, run: () => unknown | Promise<unknown>) {
	let longestTickMs = 0
	let lastTick = performance.now()
	const timer = setInterval(() => {
		const now = performance.now()
		longestTickMs = Math.max(longestTickMs, now - lastTick)
		lastTick = now
	}, 5)
	const start = performance.now()
	try {
		await run()
		const elapsedMs = performance.now() - start
		await new Promise((resolve) => setTimeout(resolve, 10))
		console.log(JSON.stringify({ name, elapsedMs, longestTickMs }))
		if (longestTickMs > 100) throw new Error(`${name} blocked the event loop for ${longestTickMs}ms`)
	} finally {
		clearInterval(timer)
	}
}
try {
	const prefix = Array.from({ length: large ? 5_000 : 20 }, (_, i) => `prefix ${i}`)
	const context = Array.from({ length: large ? 10_000 : 80 }, (_, i) => `const value_${i} = "${"a".repeat(large ? 400 : 12)}"`)
	const original = [...prefix, ...context].join("\n")
	await writeFile(join(cwd, "large.ts"), original)
	const patch = [
		"*** Begin Patch",
		"*** Update File: large.ts",
		"@@",
		...context.map((l) => ` ${l}`),
		"+tail",
		"*** End Patch",
	].join("\n")
	await measure("patch-context-after-prefix", async () => {
		const { changes } = await computePatchChanges(patch, cwd)
		if (changes["large.ts"].newContent !== `${original}\ntail`) throw new Error("Incorrect patch content")
	})
	const fuzzyPrefix = Array.from({ length: 400 }, (_, i) => `unrelated prefix ${i}`)
	const fuzzyContext = ["hello world", "middle context", "last context"]
	await writeFile(join(cwd, "fuzzy.txt"), [...fuzzyPrefix, "hello worlt", ...fuzzyContext.slice(1)].join("\n"))
	await measure("patch-fuzzy-after-400-lines", async () => {
		const { changes, fuzz } = await computePatchChanges(
			["*** Update File: fuzzy.txt", "@@", ...fuzzyContext.map((line) => `-${line}`), "+changed"].join("\n"),
			cwd,
		)
		if (fuzz !== 1_000 || changes["fuzzy.txt"].newContent !== [...fuzzyPrefix, "changed"].join("\n"))
			throw new Error("Incorrect fuzzy location")
	})
	const fuzzyLine = "a".repeat(1_024)
	await writeFile(join(cwd, "fuzzy.txt"), `${fuzzyLine.slice(0, -1)}b`)
	await measure("patch-fuzzy-1kb-context", async () => {
		const { changes, fuzz } = await computePatchChanges(`*** Update File: fuzzy.txt\n@@\n-${fuzzyLine}\n+changed`, cwd)
		if (fuzz !== 1_000 || changes["fuzzy.txt"].newContent !== "changed") throw new Error("Incorrect 1 KB fuzzy match")
	})

	const beforeLines = Array.from({ length: large ? 20_000 : 2_500 }, (_, i) => `before ${i}${large ? "x".repeat(220) : ""}`)
	const before = beforeLines.join("\n")
	const after = before.replaceAll("before", "after")
	await measure("preview-all-lines-changed", () => {
		const animation = buildEditPreviewAnimation(before, after)
		if (animation.frames.at(-1)?.content !== after) throw new Error("Incomplete preview")
	})
	if (large) {
		await writeFile(join(cwd, "many.txt"), before)
		const hunks = ["*** Update File: many.txt"]
		const expected = [...beforeLines]
		for (let i = 0; i < beforeLines.length; i += 4) {
			hunks.push("@@", `-${beforeLines[i]}`, `+changed ${i}`)
			expected[i] = `changed ${i}`
		}
		await measure("patch-5k-hunks", () => createApplyPatchExecutor()({ input: hunks.join("\n") }, cwd, {} as never))
		if ((await readFile(join(cwd, "many.txt"), "utf8")) !== expected.join("\n")) throw new Error("Incorrect many-hunk edit")
		const giantLine = "x".repeat(2 * 1024 * 1024)
		await writeFile(join(cwd, "giant.txt"), `prefix\n${giantLine}`)
		await measure("patch-single-2mb-line", () =>
			createApplyPatchExecutor()({ input: `*** Update File: giant.txt\n@@\n-${giantLine}\n+complete` }, cwd, {} as never),
		)
		if ((await readFile(join(cwd, "giant.txt"), "utf8")) !== "prefix\ncomplete") throw new Error("Incorrect giant-line edit")
		await writeFile(join(cwd, "large.ts"), before)
		await measure("editor-20k-lines", () =>
			createEditorExecutor()({ path: "large.ts", old_text: before, new_text: after }, cwd, {} as never),
		)
		if ((await readFile(join(cwd, "large.ts"), "utf8")) !== after) throw new Error("Incorrect editor content")
	}
} finally {
	await rm(cwd, { recursive: true, force: true })
}
