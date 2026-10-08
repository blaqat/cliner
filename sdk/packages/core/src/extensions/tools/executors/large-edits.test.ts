import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePatchChanges, createApplyPatchExecutor } from "./apply-patch";
import { PatchParser } from "./apply-patch-parser";
import { createEditorExecutor } from "./editor";

async function withHeartbeat(run: () => Promise<unknown>) {
	let last = performance.now();
	let longest = 0;
	let ticks = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		longest = Math.max(longest, now - last);
		last = now;
		ticks++;
	}, 1);
	const start = performance.now();
	try {
		await run();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(performance.now() - start).toBeLessThan(20_000);
		expect(longest).toBeLessThan(1_000);
		return ticks;
	} finally {
		clearInterval(timer);
	}
}

describe("large edits keep complete file content and a responsive host", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "large-edits-"));
	});
	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("finds a 2 MB exact block after a prefix without fuzzy matching and yields during parsing", async () => {
		const prefix = Array.from({ length: 5_000 }, (_, i) => `prefix ${i}`);
		const context = Array.from(
			{ length: 15_000 },
			(_, i) => `${i} ${"x".repeat(140)}`,
		);
		const original = [...prefix, ...context].join("\n");
		const lines = [
			"*** Begin Patch",
			"*** Update File: large.txt",
			"@@",
			...context.map((line) => ` ${line}`),
			"+tail",
			"*** End Patch",
		];
		const parser = new PatchParser(lines, { "large.txt": original });
		await withHeartbeat(async () => {
			const { patch, fuzz } = await parser.parseAsync();
			expect(fuzz).toBe(0);
			expect(patch.actions["large.txt"].chunks[0].origIndex).toBe(20_000);
		});
		await fs.writeFile(path.join(cwd, "large.txt"), original);
		await withHeartbeat(() =>
			createApplyPatchExecutor()({ input: lines.join("\n") }, cwd, {} as never),
		);
		expect(await fs.readFile(path.join(cwd, "large.txt"), "utf8")).toBe(
			`${original}\ntail`,
		);
	});

	it("applies 5,000 hunks to a 20k-line file", async () => {
		const lines = Array.from(
			{ length: 20_000 },
			(_, i) => `line ${i} ${"x".repeat(80)}`,
		);
		await fs.writeFile(path.join(cwd, "many.txt"), lines.join("\n"));
		const patch = ["*** Update File: many.txt"];
		for (let i = 0; i < lines.length; i += 4) {
			patch.push("@@", `-${lines[i]}`, `+new ${i}`);
			lines[i] = `new ${i}`;
		}
		await withHeartbeat(() =>
			createApplyPatchExecutor()({ input: patch.join("\n") }, cwd, {} as never),
		);
		expect(await fs.readFile(path.join(cwd, "many.txt"), "utf8")).toBe(
			lines.join("\n"),
		);
	});

	it("matches a single 2 MB line after a prefix and preserves CRLF", async () => {
		const line = "x".repeat(2 * 1024 * 1024);
		await fs.writeFile(path.join(cwd, "line.txt"), `prefix\r\n${line}\r\ntail`);
		await withHeartbeat(() =>
			createApplyPatchExecutor()(
				{ input: `*** Update File: line.txt\n@@\n-${line}\n+changed` },
				cwd,
				{} as never,
			),
		);
		expect(await fs.readFile(path.join(cwd, "line.txt"), "utf8")).toBe(
			"prefix\r\nchanged\r\ntail",
		);
	});

	it("rejects disjoint oversized fuzzy context without applying any file in the patch", async () => {
		await fs.writeFile(path.join(cwd, "bad.txt"), "x".repeat(2 * 1024 * 1024));
		const input = `*** Add File: should-not-exist.txt\n+new\n*** Update File: bad.txt\n@@\n-${"y".repeat(2 * 1024 * 1024)}\n+changed`;
		await withHeartbeat(async () => {
			await expect(
				createApplyPatchExecutor()({ input }, cwd, {} as never),
			).rejects.toThrow("did not match");
		});
		await expect(
			fs.access(path.join(cwd, "should-not-exist.txt")),
		).rejects.toThrow();
		expect((await fs.readFile(path.join(cwd, "bad.txt"), "utf8")).length).toBe(
			2 * 1024 * 1024,
		);
	});

	it("keeps canonical, whitespace, EOF and small fuzzy matching behavior", async () => {
		await fs.writeFile(
			path.join(cwd, "match.txt"),
			"prefix\n  const s = 'hello';  \ntail",
		);
		const { changes, fuzz } = await computePatchChanges(
			"*** Update File: match.txt\n@@\n-const s = ‘hello’;\n+changed\n*** End of File",
			cwd,
		);
		expect(changes["match.txt"].newContent).toBe("prefix\nchanged\ntail");
		expect(fuzz).toBe(10_100);
		await fs.writeFile(path.join(cwd, "match.txt"), "hello world");
		const fuzzy = await computePatchChanges(
			"*** Update File: match.txt\n@@\n-hello worlt\n+changed",
			cwd,
		);
		expect(fuzzy.fuzz).toBe(1_000);
		expect(fuzzy.changes["match.txt"].newContent).toBe("changed");
		const eofFuzzy = await computePatchChanges(
			"*** Update File: match.txt\n@@\n-hello worlt\n+changed\n*** End of File",
			cwd,
		);
		expect(eofFuzzy.fuzz).toBe(1_000);
		expect(eofFuzzy.changes["match.txt"].newContent).toBe("changed");
	});

	it("creates, replaces and inserts large files without exceeding argument limits", async () => {
		const execute = createEditorExecutor();
		const original = Array.from(
			{ length: 20_000 },
			(_, i) => `${i} ${"x".repeat(220)}`,
		).join("\n");
		await withHeartbeat(() =>
			execute({ path: "edit.txt", new_text: original }, cwd, {} as never),
		);
		const changed = original.replaceAll("x", "y");
		await withHeartbeat(() =>
			execute(
				{ path: "edit.txt", old_text: original, new_text: changed },
				cwd,
				{} as never,
			),
		);
		expect(await fs.readFile(path.join(cwd, "edit.txt"), "utf8")).toBe(changed);
		const insert = Array.from(
			{ length: 150_000 },
			(_, i) => `insert ${i}`,
		).join("\n");
		await withHeartbeat(() =>
			execute(
				{ path: "edit.txt", insert_line: 2, new_text: insert },
				cwd,
				{} as never,
			),
		);
		const firstNewline = changed.indexOf("\n");
		expect(await fs.readFile(path.join(cwd, "edit.txt"), "utf8")).toBe(
			`${changed.slice(0, firstNewline)}\n${insert}${changed.slice(firstNewline)}`,
		);
	});
	it("accepts the reviewer 5,000-line hex file with a 200-line non-EOF fuzzy hunk", async () => {
		let seed = 12345;
		const hex = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return (seed >>> 24).toString(16).padStart(2, "0");
		};
		const file = Array.from(
			{ length: 5_000 },
			() => `const value = "${Array.from({ length: 30 }, hex).join("")}";`,
		);
		const context = file.slice(-200);
		context[100] = `${context[100].slice(0, 40)}x${context[100].slice(40)}`;
		const parser = new PatchParser(
			[
				"*** Update File: review.txt",
				"@@",
				...context.map((line) => `-${line}`),
				"+replacement",
				"*** End Patch",
			],
			{ "review.txt": file.join("\n") },
		);
		const start = performance.now();
		await withHeartbeat(async () => {
			const { patch, fuzz } = await parser.parseAsync();
			expect(patch.warnings).toBeUndefined();
			expect(fuzz).toBe(1_000);
			// HEAD selects the first >= 0.66 window, before the final exact block.
			expect(patch.actions["review.txt"].chunks[0].origIndex).toBe(4_767);
		});
		console.info(
			`Reviewer fuzzy case: ${(performance.now() - start).toFixed(1)} ms`,
		);
	}, 30_000);
});
