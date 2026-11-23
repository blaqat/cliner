import { expect, it } from "vitest"
import { worktreePaths } from "@/utils/worktree-paths"

it("compares real Windows paths across letter case, separators, and junctions", async () => {
	const paths = worktreePaths("win32", async (file) =>
		file.replace(/^C:\\Junction(?=\\|$)/i, "C:\\Work\\Project").replace(/^C:\\Work\\Project(?=\\|$)/i, "C:\\Work\\Project"),
	)
	expect(await paths.same("C:/Junction", "c:\\work\\PROJECT")).toBe(true)
	expect(await paths.inside("C:/Junction", "c:/work/project/..config/settings")).toBe(true)
	expect(await paths.inside("C:/Junction", "C:/work/project")).toBe(false)
	expect(await paths.inside("C:/Junction", "C:/work/project-copy")).toBe(false)
	expect(await paths.inside("C:/Junction", "D:/work/project/src")).toBe(false)
})

it("keeps case-sensitive sibling paths distinct", async () => {
	const paths = worktreePaths("darwin", async (file) => file)
	expect(await paths.same("/project/api", "/project/API")).toBe(false)
	expect(await paths.inside("/project/api", "/project/API/src")).toBe(false)
	expect(await paths.inside("/project/API", "/project/api/src")).toBe(false)
})

it("canonicalizes the ancestor of a missing path through a Windows drive alias", async () => {
	const paths = worktreePaths("win32", async (file) => {
		if (file === "Z:\\") return "C:\\Projects\\App"
		if (file === "Z:\\missing") throw Object.assign(new Error("missing"), { code: "ENOENT" })
		return file
	})
	expect(await paths.inside("C:/Projects/App", "Z:/missing")).toBe(true)
})
