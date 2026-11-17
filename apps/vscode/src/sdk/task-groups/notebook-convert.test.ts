import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createNotebookConversion, notebookConversion } from "./notebook-convert"

describe("notebook conversion", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-convert-"))
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	it.each(["rule", "workflow", "skill"] as const)("creates a %s without replacing existing files", async (kind) => {
		const file = notebookConversion(root, kind, "dev-plan", "# Plan\n", "When working on exports")
		await createNotebookConversion(file)
		expect(await fs.readFile(file.path, "utf8")).toBe(file.content)
		expect(file.path).toBe(path.join(root, kind === "skill" ? "dev-plan/SKILL.md" : "dev-plan.md"))
		if (kind === "skill") expect(file.content).toContain("description: When working on exports")
		await expect(createNotebookConversion({ ...file, content: "overwrite" })).rejects.toThrow()
		expect(await fs.readFile(file.path, "utf8")).toBe(file.content)
	})
	it("requires a skill description and refuses traversal", () => {
		expect(() => notebookConversion(root, "skill", "plan", "body", "")).toThrow("description")
		expect(() => notebookConversion(root, "rule", "../plan", "body", "")).toThrow()
	})
})
