import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { writeInside } from "./skill-files"

let root: string
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-files-"))
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

it("refuses writes through linked folders, roots, and files without touching their targets", async () => {
	const outside = path.join(root, "outside")
	const skills = path.join(root, "skills")
	await fs.mkdir(outside)
	await fs.mkdir(skills)
	await fs.writeFile(path.join(outside, "keep.md"), "mine")
	await fs.symlink(outside, path.join(skills, "scripts"))
	await fs.symlink(path.join(outside, "keep.md"), path.join(skills, "keep.md"))
	await expect(writeInside(skills, "scripts/keep.md", "theirs")).rejects.toThrow("linked")
	await expect(writeInside(path.join(skills, "scripts"), "keep.md", "theirs")).rejects.toThrow("linked")
	await expect(writeInside(skills, "keep.md", "theirs")).rejects.toThrow("linked")
	expect(await fs.readFile(path.join(outside, "keep.md"), "utf8")).toBe("mine")
})
