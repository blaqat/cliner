import { deflateRawSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { readZip, safeZipPath, writeZip, ZipError } from "./zip"

/** Points the central directory entry's name or attributes at something hostile. */
function patchCentral(zip: Buffer, patch: (copy: Buffer, central: number) => void): Buffer {
	const copy = Buffer.from(zip)
	patch(copy, copy.readUInt32LE(copy.length - 22 + 16))
	return copy
}

describe("zip", () => {
	it("round-trips files, keeping executable bits", () => {
		const zip = writeZip([
			{ path: "skills/a/SKILL.md", data: Buffer.from("---\nname: a\n---\nhello".repeat(20)) },
			{ path: "skills/a/scripts/run.sh", data: Buffer.from("#!/bin/sh\necho hi\n"), mode: 0o755 },
			{ path: "empty.txt", data: Buffer.alloc(0) },
		])
		const entries = readZip(zip)
		expect(entries.map((entry) => entry.path)).toEqual(["skills/a/SKILL.md", "skills/a/scripts/run.sh", "empty.txt"])
		expect(entries[0].data.toString()).toContain("hello")
		expect(entries[1].mode & 0o111).toBeTruthy()
		expect(entries[2].data.length).toBe(0)
	})

	it("refuses paths that leave the folder", () => {
		expect(() => safeZipPath("../evil")).toThrow(ZipError)
		expect(() => safeZipPath("a/../../evil")).toThrow(ZipError)
		expect(() => safeZipPath("/etc/passwd")).toThrow(ZipError)
		expect(() => safeZipPath("C:/Windows/x")).toThrow(ZipError)
		expect(() => safeZipPath("a\\..\\b")).toThrow(ZipError)
		expect(safeZipPath("skills/a/SKILL.md")).toBe("skills/a/SKILL.md")
		// A crafted entry with a traversal name never reaches the caller.
		const zip = writeZip([{ path: "abc/x.md", data: Buffer.from("x") }])
		const evil = patchCentral(zip, (copy, central) => copy.write("../x.md", central + 46))
		expect(() => readZip(evil)).toThrow(/Unsafe path/)
	})

	it("refuses links", () => {
		const zip = writeZip([{ path: "link", data: Buffer.from("/etc/passwd") }])
		const linked = patchCentral(zip, (copy, central) => copy.writeUInt32LE((0o120777 * 0x10000) >>> 0, central + 38))
		expect(() => readZip(linked)).toThrow(/Links aren't allowed/)
	})

	it("stops at size and count limits before inflating", () => {
		const big = writeZip([{ path: "big.md", data: Buffer.alloc(5000, 97) }])
		expect(() => readZip(big, { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 10_000 })).toThrow(/at most/)
		const many = writeZip(Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.md`, data: Buffer.from("x") })))
		expect(() => readZip(many, { maxEntries: 4, maxEntryBytes: 1000, maxTotalBytes: 10_000 })).toThrow(/at most 4/)
		const total = writeZip(Array.from({ length: 3 }, (_, i) => ({ path: `f${i}.md`, data: Buffer.alloc(600, 98) })))
		expect(() => readZip(total, { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 1000 })).toThrow(/unpacks to more/)
	})

	it("never inflates past the declared size (a zip bomb that lies)", () => {
		const zip = writeZip([{ path: "a.md", data: Buffer.alloc(4000, 97) }])
		// Claim 10 bytes; the real data is 4000.
		const lying = patchCentral(zip, (copy, central) => copy.writeUInt32LE(10, central + 24))
		expect(() => readZip(lying)).toThrow(ZipError)
		expect(deflateRawSync(Buffer.alloc(4000, 97)).length).toBeLessThan(4000)
	})

	it("rejects things that aren't zips", () => {
		expect(() => readZip(Buffer.from("hello world, definitely not a zip file"))).toThrow(/isn't a zip/)
	})
})
