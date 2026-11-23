import { expect, it } from "vitest"
import { worktreePaths } from "@/utils/worktree-paths"

it("compares real Windows paths across letter case, separators, and junctions", async () => {
	const paths = worktreePaths("win32", async (file) => file.replace(/^C:\\Junction(?=\\|$)/i, "C:\\Work\\Project"))
	expect(await paths.same("C:/Junction", "c:\\work\\PROJECT")).toBe(true)
	expect(await paths.inside("C:/Junction", "c:/work/project/..config/settings")).toBe(true)
	expect(await paths.inside("C:/Junction", "C:/work/project")).toBe(false)
	expect(await paths.inside("C:/Junction", "C:/work/project-copy")).toBe(false)
	expect(await paths.inside("C:/Junction", "D:/work/project/src")).toBe(false)
})
