import { describe, expect, it } from "vitest";
import {
	PatchParser as LegacyParser,
	setDistanceOracle,
} from "./__fixtures__/legacy-apply-patch-parser";
import { type Patch, PatchParser } from "./apply-patch-parser";

// Fixture preserves HEAD matching logic and defaults to its original distance.
// Large cases inject an independent exact oracle to avoid HEAD's quadratic memory.
// Compare observable executor outcomes: skipped hunks and exceptions both fail;
// successful parses must have identical chunk locations, fuzz and final content.
function outcome(
	Parser: typeof PatchParser | typeof LegacyParser,
	lines: string[],
	content: string,
) {
	try {
		const result = new Parser(lines, { "file.txt": content }).parse();
		if (result.patch.warnings?.length) return { failed: true };
		return { ...result, output: output(result.patch as Patch, content) };
	} catch {
		return { failed: true };
	}
}

function output(patch: Patch, content: string) {
	const lines = content.split("\n");
	const out: string[] = [];
	let offset = 0;
	for (const chunk of patch.actions["file.txt"].chunks) {
		if (chunk.origIndex < offset || chunk.origIndex > lines.length)
			throw new Error("Invalid offset");
		out.push(...lines.slice(offset, chunk.origIndex), ...chunk.insLines);
		offset = chunk.origIndex + chunk.delLines.length;
	}
	return out.concat(lines.slice(offset)).join("\n");
}

function patch(context: string[], eof = false, prefix: string[] = []) {
	return [
		"*** Begin Patch",
		"*** Update File: file.txt",
		...prefix,
		"@@",
		...context.map((line) => `-${line}`),
		"+replacement",
		...(eof ? ["*** End of File"] : []),
		"*** End Patch",
	];
}

function compare(lines: string[], content: string, label: string) {
	expect(outcome(PatchParser, lines, content), label).toEqual(
		outcome(LegacyParser, lines, content),
	);
}

// Independent Wagner-Fischer recurrence, not the production banded/bit-vector
// implementation. Equal affixes can be removed without changing edit distance.
// Memoization makes repeated full-sized windows affordable for the HEAD matcher.
function legacyDistanceOracle() {
	const cache = new Map<string, number>();
	return (a: string, b: string): number => {
		const key = JSON.stringify([a, b]);
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		let start = 0;
		let aEnd = a.length;
		let bEnd = b.length;
		while (start < aEnd && start < bEnd && a[start] === b[start]) start++;
		while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
			aEnd--;
			bEnd--;
		}
		a = a.slice(start, aEnd);
		b = b.slice(start, bEnd);
		if (a.length > b.length) [a, b] = [b, a];
		let previous = Uint32Array.from({ length: a.length + 1 }, (_, i) => i);
		let current = new Uint32Array(a.length + 1);
		for (let i = 1; i <= b.length; i++) {
			current[0] = i;
			for (let j = 1; j <= a.length; j++) {
				current[j] = Math.min(
					previous[j] + 1,
					current[j - 1] + 1,
					previous[j - 1] +
						(a.charCodeAt(j - 1) === b.charCodeAt(i - 1) ? 0 : 1),
				);
			}
			[previous, current] = [current, previous];
		}
		const distance = previous[a.length];
		cache.set(key, distance);
		return distance;
	};
}

describe("apply_patch matching agrees with HEAD", () => {
	it("preserves EOF fuzzy precedence over an earlier exact match", () => {
		const content = "hello world\nunrelated\nhello worlt";
		const lines = patch(["hello world"], true);
		compare(lines, content, "EOF precedence");
		expect(outcome(PatchParser, lines, content)).toMatchObject({
			output: "hello world\nunrelated\nreplacement",
		});
	});

	it("matches 6,000 seeded cases with repeats, near duplicates, whitespace, CRLF, Unicode and multiple hunks", async () => {
		let seed = 0x5eed1234;
		const random = (n: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % n;
		};
		const vocabulary = [
			"hello world",
			"hello worlt",
			"other",
			"repeat",
			"",
			"a",
			"ab",
			"café",
			"cafe\u0301",
			"‘x’",
			"'x'",
			"a—b",
			"a-b",
			"\t spaced  ",
			" spaced",
			"\u00a0x",
			"x\r",
			"😀x",
			'\\"x\\"',
			'"x"',
		];
		for (let test = 0; test < 6_000; test++) {
			const file = Array.from(
				{ length: 1 + random(18) },
				() => vocabulary[random(vocabulary.length)],
			);
			const start =
				test % 5 === 0
					? 0
					: test % 5 === 1
						? file.length - 1
						: random(file.length);
			let context = file.slice(start, start + 1 + random(4));
			if (test % 3 === 0) context = context.map((line) => line.trim());
			if (test % 3 === 1) context[0] += "z";
			if (test % 11 === 0) context.push("missing", "context");
			const prefix =
				test % 7 === 0
					? ["@@", `-${file[0]}`, "+first", "+extra"]
					: test % 13 === 0
						? [`@@ ${file[0]}`]
						: [];
			const lines = patch(context, test % 2 === 0, prefix);
			compare(lines, file.join("\n"), `seeded case ${test}`);
			if (test % 250 === 0) {
				const expected = outcome(LegacyParser, lines, file.join("\n"));
				try {
					const actual = await new PatchParser(lines, {
						"file.txt": file.join("\n"),
					}).parseAsync();
					expect(
						actual.patch.warnings?.length
							? { failed: true }
							: { ...actual, output: output(actual.patch, file.join("\n")) },
					).toEqual(expected);
				} catch {
					expect(expected).toEqual({ failed: true });
				}
			}
		}
	});

	it("preserves threshold decisions for 2,000 generated string pairs", () => {
		for (let i = 0; i < 2_000; i++) {
			const a = `${"a".repeat(i % 47)}${"b".repeat(i % 13)}${i % 5}`;
			const b = `${"a".repeat((i * 7) % 47)}${"c".repeat(i % 17)}${i % 7}`;
			compare(patch([a], i % 2 === 0), b, `threshold ${i}`);
		}
	});

	it("accepts a three-line fuzzy hunk after 400 unrelated lines and a 1 KB near match", () => {
		const context = ["hello world", "middle context", "last context"];
		compare(
			patch(context),
			[
				...Array.from({ length: 400 }, (_, i) => `unrelated prefix ${i}`),
				"hello worlt",
				...context.slice(1),
			].join("\n"),
			"400 prefix lines",
		);
		const large = "a".repeat(1_024);
		compare(patch([large]), `${large.slice(0, -1)}b`, "1KB one-character edit");
	});

	it("does not hit the safety limit at 5,000 file lines and 200 context lines", () => {
		for (let i = 0; i < 12; i++) {
			const context = Array.from({ length: 200 }, (_, j) => `x${j % 10}`);
			const file = [
				...Array.from({ length: 4_800 }, () => "unrelated"),
				...context,
			];
			if (i % 2) file[file.length - 1] = "xy";
			expect(
				outcome(
					PatchParser,
					patch(context, true),
					file.join(i % 3 === 0 ? "\r\n" : "\n"),
				),
			).not.toHaveProperty("failed");
			compare(
				patch(context, true),
				file.join(i % 3 === 0 ? "\r\n" : "\n"),
				`boundary ${i}`,
			);
		}
	}, 60_000);
	it("matches word boundaries and non-EOF long-line windows against the unchanged HEAD distance", () => {
		let seed = 0x12345678;
		const random = (n: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return (seed >>> 16) % n;
		};
		const text = (n: number) =>
			Array.from({ length: n }, () => "abcdef😀"[random(8)]).join("");
		for (let i = 0; i < 300; i++) {
			const a = text(
				[31, 32, 33, 63, 64, 65, 95, 96, 97, 127, 128, 129][i % 12],
			);
			const b =
				i % 2
					? text(a.length + random(5))
					: a.slice(0, random(a.length)) + text(3) + a.slice(random(a.length));
			compare(patch([a]), b, `word boundary ${i}`);
		}
		for (let i = 0; i < 60; i++) {
			const file = Array.from(
				{ length: 12 + random(8) },
				() => `const value = "${text(24 + random(81))}";`,
			);
			const context = file.slice(-4 - random(3));
			const line = random(context.length);
			context[line] =
				context[line].slice(0, 20) +
				"x".repeat(1 + (i % 3)) +
				context[line].slice(20);
			compare(patch(context), file.join("\n"), `long non-EOF ${i}`);
		}
	}, 60_000);

	it("matches realistic non-EOF hunks up to 200 lines in files up to 5,000 lines", async () => {
		const oracle = legacyDistanceOracle();
		// Confirm the injected distance against HEAD's untouched matrix path.
		const samples = Array.from({ length: 120 }, (_, i) => ({
			lines: patch([`a${"xyz".repeat(i % 40)}${i}`]),
			content: `b${"xzy".repeat(i % 37)}${i % 7}`,
		}));
		const expectedSamples = samples.map(({ lines, content }) =>
			outcome(LegacyParser, lines, content),
		);
		setDistanceOracle(oracle);
		try {
			samples.forEach(({ lines, content }, i) => {
				expect(outcome(LegacyParser, lines, content)).toEqual(
					expectedSamples[i],
				);
			});
			for (const [fileSize, hunkSize, lineSize, edits] of [
				[40, 8, 40, 1],
				[400, 30, 80, 2],
				[5_000, 200, 120, 3],
			]) {
				const line = `const value = "${"a".repeat(lineSize - 17)}";`;
				const file = [
					...Array.from({ length: fileSize - hunkSize }, () =>
						fileSize === 5_000 ? line : "/".repeat(lineSize),
					),
					...Array.from({ length: hunkSize }, () => line),
				];
				const context = file.slice(-hunkSize);
				context[Math.floor(hunkSize / 2)] += "x".repeat(edits);
				const content = file.join("\n");
				const lines = patch(context);
				const expected = outcome(LegacyParser, lines, content);
				expect(expected).not.toHaveProperty("failed");
				const result = await new PatchParser(lines, {
					"file.txt": content,
				}).parseAsync();
				expect({ ...result, output: output(result.patch, content) }).toEqual(
					expected,
				);
			}
		} finally {
			setDistanceOracle();
		}
	}, 60_000);
});
