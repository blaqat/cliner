import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseDoc, readDocFile, resolveDocPath, saveDocFile, serializeDoc } from "./docFiles"

describe("doc editor files", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-doc-files-"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("reads front matter as fields and the body without it", () => {
		const doc = parseDoc("/x.md", "---\nname: pdf\ndescription: Read PDFs\ncustom: 3\n---\n\n# PDF\nBody")
		expect(doc.fields).toEqual({ name: "pdf", description: "Read PDFs", custom: 3 })
		expect(doc.body).toBe("# PDF\nBody")
		expect(doc.readOnlyReason).toBeUndefined()
	})

	it("keeps unreadable front matter read-only instead of rewriting it", () => {
		const doc = parseDoc("/x.md", "---\nname: [oops\n---\nBody")
		expect(doc.readOnlyReason).toContain("can't be read")
		expect(doc.fields).toEqual({})
	})

	it("writes fields back as front matter, dropping empty ones, and a plain body when none are left", () => {
		expect(serializeDoc({ paths: ["src/**"], description: "", other: 1 }, "Body")).toBe(
			"---\npaths:\n  - src/**\nother: 1\n---\n\nBody",
		)
		expect(serializeDoc({ paths: [] }, "Body")).toBe("Body")
	})

	it("saves, and refuses when the file changed after it was read", async () => {
		const file = path.join(dir, "rule.md")
		await fs.writeFile(file, "Old")
		const read = await readDocFile(file)
		const saved = await saveDocFile(file, { body: "New", fields: { paths: ["a/**"] }, baseRevision: read.revision })
		expect(await fs.readFile(file, "utf8")).toBe("---\npaths:\n  - a/**\n---\n\nNew")
		await expect(saveDocFile(file, { body: "Lost?", fields: {}, baseRevision: read.revision })).rejects.toThrow(
			"changed after you opened it",
		)
		expect(saved.fields).toEqual({ paths: ["a/**"] })
	})

	it("only opens files the Rules panel lists", async () => {
		const file = path.join(dir, "rule.md")
		await fs.writeFile(file, "x")
		const controller = {
			stateManager: {
				getGlobalSettingsKey: (key: string) => (key === "globalClineRulesToggles" ? { [file]: true } : {}),
				getWorkspaceStateKey: () => ({}),
			},
		} as never
		expect(await resolveDocPath(controller, "rule", file)).toBe(file)
		await expect(resolveDocPath(controller, "rule", path.join(dir, "other.md"))).rejects.toThrow("isn't in the Rules panel")
		await expect(resolveDocPath(controller, "workflow", file)).rejects.toThrow("isn't in the Rules panel")
		await expect(resolveDocPath(controller, "skill", "remote:x")).rejects.toThrow("managed remotely")
	})
})
