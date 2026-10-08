import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplyPatchExecutor } from "./apply-patch";
import { PATCH_MATCHING_TIMEOUT_MS, PatchParser } from "./apply-patch-parser";
import { createEditorExecutor } from "./editor";

vi.mock("node:fs/promises", { spy: true });
vi.mock("node:fs", { spy: true });

describe("edit snapshot and cancellation validation", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "edit-validation-"));
	});
	afterEach(async () => {
		vi.resetAllMocks();
		vi.restoreAllMocks();
		await fs.rm(cwd, { recursive: true, force: true });
	});

	function duringYield(change: () => void) {
		// Force a scheduler checkpoint deterministically, regardless of machine speed.
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (now += 10));
		const schedule = globalThis.setImmediate;
		let changed = false;
		return vi.spyOn(globalThis, "setImmediate").mockImplementation(((
			callback: () => void,
		) => {
			if (!changed) {
				changed = true;
				change();
			}
			return schedule(callback);
		}) as typeof setImmediate);
	}

	it.each([
		undefined,
		new Error("custom cancellation reason"),
	])("throws AbortError after a matching yield with any abort reason", async (reason) => {
		const controller = new AbortController();
		const yieldSpy = duringYield(() => controller.abort(reason));
		const parser = new PatchParser(
			["*** Update File: file.txt", "@@", "-hello world", "+changed"],
			{ "file.txt": "hello worlt" },
			controller.signal,
		);
		await expect(parser.parseAsync()).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(yieldSpy).toHaveBeenCalled();
	});

	it("does not write any file when cancelled and edited during a yield", async () => {
		await fs.writeFile(path.join(cwd, "file.txt"), "hello world");
		const controller = new AbortController();
		duringYield(() => {
			fsSync.writeFileSync(path.join(cwd, "file.txt"), "intervening change");
			controller.abort();
		});
		await expect(
			createApplyPatchExecutor()(
				{
					input:
						"*** Add File: new.txt\n+new\n*** Update File: file.txt\n@@\n-hello world\n+changed",
				},
				cwd,
				{ signal: controller.signal } as never,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(await fs.readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
			"intervening change",
		);
		expect(fsSync.existsSync(path.join(cwd, "new.txt"))).toBe(false);
	});

	it.each([
		"update",
		"delete",
		"add",
		"move",
	])("validates every %s snapshot before a multi-file patch writes", async (kind) => {
		await fs.writeFile(path.join(cwd, "first.txt"), "first");
		await fs.writeFile(path.join(cwd, "file.txt"), "hello world\r\ntail");
		await fs.writeFile(path.join(cwd, "destination.txt"), "destination");
		const input =
			"*** Update File: first.txt\n@@\n-first\n+changed\n" +
			(kind === "delete"
				? "*** Delete File: file.txt"
				: kind === "add"
					? "*** Add File: new.txt\n+new"
					: `*** Update File: file.txt\n${kind === "move" ? "*** Move to: destination.txt\n" : ""}@@\n-hello world\n+changed`);
		const changedPath = path.join(
			cwd,
			kind === "add"
				? "new.txt"
				: kind === "move"
					? "destination.txt"
					: "file.txt",
		);
		duringYield(() => fsSync.writeFileSync(changedPath, "intervening change"));
		await expect(
			createApplyPatchExecutor()({ input }, cwd, {} as never),
		).rejects.toThrow(
			"file changed during patch application; re-read and retry",
		);
		expect(await fs.readFile(path.join(cwd, "first.txt"), "utf8")).toBe(
			"first",
		);
		expect(await fs.readFile(changedPath, "utf8")).toBe("intervening change");
		if (kind === "move")
			expect(await fs.readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
				"hello world\r\ntail",
			);
	});

	it.each([
		"cancel",
		"change",
	])("guards editor %s after reading its snapshot", async (action) => {
		const target = path.join(cwd, "file.txt");
		await fs.writeFile(target, "original");
		const controller = new AbortController();
		const { readFile } =
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			);
		vi.spyOn(fs, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.readFile>
		) => {
			const result = await readFile(...args);
			if (String(args[0]) === target) {
				if (action === "cancel") controller.abort();
				else fsSync.writeFileSync(target, "intervening change");
			}
			return result;
		}) as typeof fs.readFile);
		const editing = createEditorExecutor()(
			{ path: "file.txt", old_text: "original", new_text: "changed" },
			cwd,
			{ signal: controller.signal } as never,
		);
		if (action === "cancel")
			await expect(editing).rejects.toMatchObject({ name: "AbortError" });
		else
			await expect(editing).rejects.toThrow(
				"file changed during patch application; re-read and retry",
			);
		expect(fsSync.readFileSync(target, "utf8")).toBe(
			action === "cancel" ? "original" : "intervening change",
		);
	});

	it.each([
		"create",
		"replace",
		"insert",
	])("checks editor cancellation after filesystem awaits for %s", async (kind) => {
		const controller = new AbortController();
		controller.abort("cancelled");
		await fs.writeFile(path.join(cwd, "file.txt"), "original");
		await expect(
			createEditorExecutor()(
				{
					path: kind === "create" ? "new.txt" : "file.txt",
					old_text: "original",
					new_text: "changed",
					...(kind === "insert" ? { insert_line: 1 } : {}),
				},
				cwd,
				{ signal: controller.signal } as never,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(await fs.readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
			"original",
		);
		expect(fsSync.existsSync(path.join(cwd, "new.txt"))).toBe(false);
	});
	it("keeps the original snapshot when a move destination is also a source", async () => {
		const target = path.join(cwd, "first.txt");
		await fs.writeFile(target, "first");
		await fs.writeFile(path.join(cwd, "second.txt"), "second");
		const { readFile } =
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			);
		let changed = false;
		vi.spyOn(fs, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.readFile>
		) => {
			const result = await readFile(...args);
			if (!changed && String(args[0]) === target) {
				changed = true;
				fsSync.writeFileSync(target, "intervening change");
			}
			return result;
		}) as typeof fs.readFile);
		await expect(
			createApplyPatchExecutor()(
				{
					input:
						"*** Update File: first.txt\n@@\n-first\n+changed\n*** Update File: second.txt\n*** Move to: first.txt\n@@\n-second\n+moved",
				},
				cwd,
				{} as never,
			),
		).rejects.toThrow(
			"file changed during patch application; re-read and retry",
		);
		expect(fsSync.readFileSync(target, "utf8")).toBe("intervening change");
		expect(fsSync.readFileSync(path.join(cwd, "second.txt"), "utf8")).toBe(
			"second",
		);
	});
	it.each([
		"update",
		"delete",
		"add",
		"move source",
		"move destination",
	])("stops and reports completed and pending files after a late %s change", async (kind) => {
		const first = path.join(cwd, "first.txt");
		const target = path.join(cwd, "file.txt");
		const destination = path.join(cwd, "destination.txt");
		await fs.writeFile(first, "first");
		await fs.writeFile(target, "original");
		await fs.writeFile(path.join(cwd, "last.txt"), "last");
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.spyOn(fsSync, "writeFileSync").mockImplementation((...args) => {
			actual.writeFileSync(...args);
			if (String(args[0]) === first) {
				actual.writeFileSync(
					kind === "add"
						? path.join(cwd, "new.txt")
						: kind === "move destination"
							? destination
							: target,
					"external",
				);
			}
		});
		const operation =
			kind === "delete"
				? "*** Delete File: file.txt"
				: kind === "add"
					? "*** Add File: new.txt\n+new"
					: `*** Update File: file.txt\n${kind.startsWith("move") ? "*** Move to: destination.txt\n" : ""}@@\n-original\n+changed`;
		const input = `*** Update File: first.txt\n@@\n-first\n+changed\n${operation}\n*** Update File: last.txt\n@@\n-last\n+changed`;
		await expect(
			createApplyPatchExecutor()({ input }, cwd, {} as never),
		).rejects.toThrow(
			`file changed during patch application; re-read and retry\nPatch stopped before all operations completed.\nCompleted file operations:\nfirst.txt: written\nFile operations not completed:\n${kind === "add" ? "new.txt: written" : kind.startsWith("move") ? "destination.txt: written\nfile.txt: deleted" : `file.txt: ${kind === "delete" ? "deleted" : "written"}`}\nlast.txt: written`,
		);
		expect(actual.readFileSync(first, "utf8")).toBe("changed");
		expect(actual.readFileSync(path.join(cwd, "last.txt"), "utf8")).toBe(
			"last",
		);
		if (kind === "move destination")
			expect(actual.readFileSync(target, "utf8")).toBe("original");
		if (kind === "move source")
			expect(actual.existsSync(destination)).toBe(false);
	});

	it.each([
		"patch add",
		"editor create",
		"move destination",
	])("uses exclusive creation when a file appears after the last check for %s", async (kind) => {
		const target = path.join(cwd, "new.txt");
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		let injected = false;
		vi.spyOn(fsSync, "writeFileSync").mockImplementation((...args) => {
			if (String(args[0]) === target && !injected) {
				injected = true;
				actual.writeFileSync(target, "external");
			}
			actual.writeFileSync(...args);
		});
		await fs.writeFile(path.join(cwd, "file.txt"), "original");
		const editing =
			kind === "editor create"
				? createEditorExecutor()(
						{ path: "new.txt", new_text: "changed" },
						cwd,
						{} as never,
					)
				: createApplyPatchExecutor()(
						{
							input:
								kind === "patch add"
									? "*** Add File: new.txt\n+changed"
									: "*** Update File: file.txt\n*** Move to: new.txt\n@@\n-original\n+changed",
						},
						cwd,
						{} as never,
					);
		await expect(editing).rejects.toThrow(
			"file changed during patch application; re-read and retry",
		);
		expect(injected).toBe(true);
		expect(actual.readFileSync(target, "utf8")).toBe("external");
		expect(actual.readFileSync(path.join(cwd, "file.txt"), "utf8")).toBe(
			"original",
		);
	});

	it("checks the editor create snapshot again after creating parent directories", async () => {
		const target = path.join(cwd, "new.txt");
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
			const result = actual.mkdirSync(...args);
			actual.writeFileSync(target, "external");
			return result;
		});
		await expect(
			createEditorExecutor()(
				{ path: "new.txt", new_text: "changed" },
				cwd,
				{} as never,
			),
		).rejects.toThrow(
			"file changed during patch application; re-read and retry",
		);
		expect(actual.readFileSync(target, "utf8")).toBe("external");
	});

	it("reports a written move destination if the source changes before deletion", async () => {
		const source = path.join(cwd, "file.txt");
		const destination = path.join(cwd, "new.txt");
		await fs.writeFile(source, "original");
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.spyOn(fsSync, "writeFileSync").mockImplementation((...args) => {
			actual.writeFileSync(...args);
			if (String(args[0]) === destination)
				actual.writeFileSync(source, "external");
		});
		await expect(
			createApplyPatchExecutor()(
				{
					input:
						"*** Update File: file.txt\n*** Move to: new.txt\n@@\n-original\n+changed",
				},
				cwd,
				{} as never,
			),
		).rejects.toThrow(
			"Completed file operations:\nnew.txt: written\nFile operations not completed:\nfile.txt: deleted",
		);
		expect(actual.readFileSync(destination, "utf8")).toBe("changed");
		expect(actual.readFileSync(source, "utf8")).toBe("external");
	});

	it("accepts later operations on paths changed by the patch itself", async () => {
		await fs.writeFile(path.join(cwd, "first.txt"), "first");
		await fs.writeFile(path.join(cwd, "second.txt"), "second");
		await createApplyPatchExecutor()(
			{
				input:
					"*** Update File: first.txt\n@@\n-first\n+changed\n*** Update File: second.txt\n*** Move to: first.txt\n@@\n-second\n+moved",
			},
			cwd,
			{} as never,
		);
		expect(await fs.readFile(path.join(cwd, "first.txt"), "utf8")).toBe(
			"moved",
		);
		expect(fsSync.existsSync(path.join(cwd, "second.txt"))).toBe(false);
	});

	it.each([
		"parse",
		"parseAsync",
	] as const)("limits pathological matching time in %s", async (method) => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(
			() => (now += PATCH_MATCHING_TIMEOUT_MS + 1),
		);
		const parser = new PatchParser(
			["*** Update File: file.txt", "@@", "-hello world", "+changed"],
			{ "file.txt": "hello worlt" },
		);
		await expect(async () => parser[method]()).rejects.toThrow(
			"pathological fuzzy matching safety limit",
		);
	});
});
