import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentToolContext } from "@cline/shared"
import { SKILL_DRAFTS_ID } from "@shared/skillsets"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NotebookStore } from "../task-groups/notebook-store"
import { applySkillDraft, createSkillDraftTool, type SkillDraftPlaces } from "./skill-drafts"
import { parseSkillMarkdown } from "./skill-files"

describe("skill drafts", () => {
	let root: string
	let store: NotebookStore
	let places: SkillDraftPlaces
	let enabled: string[]
	const context = {} as AgentToolContext
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-skill-drafts-"))
		store = new NotebookStore(path.join(root, "task-groups"))
		const workspace = path.join(root, "workspace")
		await fs.mkdir(workspace, { recursive: true })
		enabled = []
		places = {
			workspaceRoot: workspace,
			skillScanDirs: () => [
				{ path: path.join(workspace, ".agents", "skills"), isGlobal: false },
				{ path: path.join(root, "global-skills"), isGlobal: true },
			],
			skillsDir: async (scope) =>
				scope === "global" ? path.join(root, "global-skills") : path.join(workspace, ".agents", "skills"),
			workflowsDir: async (scope) =>
				scope === "global" ? path.join(root, "workflows") : path.join(workspace, ".clinerules", "workflows"),
			workflowDirs: async () => [{ path: path.join(root, "workflows"), isGlobal: true }],
		}
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	const execute = async (input: Record<string, unknown>) => {
		const tool = await createSkillDraftTool({ rootThreadId: "t1", store, places })
		return tool.execute(input as never, context)
	}
	const keep = async (slug: string) => {
		const pending = (await store.readPendingReview(SKILL_DRAFTS_ID, "t1"))!
		slug =
			pending.changes.find((change) => change.slug === slug)?.slug ??
			pending.changes.find((change) => change.name === slug.replace(/^(skill|workflow)-/, ""))?.slug ??
			slug
		const applied = await store.applyPendingChanges(
			SKILL_DRAFTS_ID,
			"t1",
			(await store.readPendingReview(SKILL_DRAFTS_ID, "t1"))!.revision,
			[{ slug, include: true }],
			{
				apply: (change, edited) =>
					applySkillDraft(change, edited, places, async (_kind, file) => {
						enabled.push(file)
					}),
			},
		)
		return applied
	}

	it("stages a new skill with files; nothing is written until it's kept", async () => {
		expect(
			await execute({
				kind: "skill",
				name: "Release Checklist",
				description: "Cut a release: bump, changelog, tag",
				content: "# Release\n1. Bump\n2. Tag",
				files: [{ path: "scripts/verify-tag.sh", content: "#!/bin/sh\n" }],
				summary: "Release steps from this thread",
			}),
		).toMatch(/Staged/)
		await expect(fs.access(path.join(root, "global-skills"))).rejects.toThrow()
		const [change] = (await store.readPending(SKILL_DRAFTS_ID, "t1")) ?? []
		expect(change).toMatchObject({ op: "create", slug: "skill-release-checklist", skill: { kind: "skill", scope: "global" } })

		await keep("skill-release-checklist")
		const skillMd = path.join(root, "global-skills", "release-checklist", "SKILL.md")
		const parsed = parseSkillMarkdown(await fs.readFile(skillMd, "utf8"))
		expect(parsed).toMatchObject({ name: "release-checklist", description: "Cut a release: bump, changelog, tag" })
		expect(parsed.body).toContain("1. Bump")
		expect(await fs.readFile(path.join(root, "global-skills", "release-checklist", "scripts", "verify-tag.sh"), "utf8")).toBe(
			"#!/bin/sh\n",
		)
		expect(
			(await fs.stat(path.join(root, "global-skills", "release-checklist", "scripts", "verify-tag.sh"))).mode & 0o111,
		).toBeTruthy()
		expect(enabled).toEqual([skillMd])
		expect(await store.readPending(SKILL_DRAFTS_ID, "t1")).toBeUndefined()
	})

	it("switches kind and place from the review row before keeping", async () => {
		await execute({ kind: "skill", name: "deploy", description: "Deploy", content: "Steps" })
		await store.updatePendingSkill(SKILL_DRAFTS_ID, "t1", "skill-deploy", {
			kind: "workflow",
			scope: "workspace",
			name: "ship-it",
		})
		await keep("skill-deploy")
		const file = path.join(root, "workspace", ".clinerules", "workflows", "ship-it.md")
		expect(await fs.readFile(file, "utf8")).toBe("Steps\n")
		expect(enabled).toEqual([file])
	})

	it("edits only the row the user saw and returns the revision a keep needs", async () => {
		await execute({ kind: "skill", name: "deploy", description: "Deploy", content: "Steps" })
		const seen = (await store.readPendingReview(SKILL_DRAFTS_ID, "t1"))!.revision
		const next = await store.updatePendingSkill(SKILL_DRAFTS_ID, "t1", "skill-deploy", { description: "Ship it" }, seen)
		const pending = (await store.readPendingReview(SKILL_DRAFTS_ID, "t1"))!
		expect(next).toBe(pending.revision)
		expect(pending.changes[0].description).toBe("Ship it")
		await expect(
			store.updatePendingSkill(SKILL_DRAFTS_ID, "t1", "skill-deploy", { description: "Stale" }, seen),
		).rejects.toThrow("These changes were updated")
	})

	it("edits an existing skill in place, diffed against what's there", async () => {
		const dir = path.join(root, "global-skills", "sql-style")
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(
			path.join(dir, "SKILL.md"),
			"---\nname: sql-style\ndescription: SQL\ndisabled: true\n---\n\nold line\n",
		)
		await execute({ kind: "skill", name: "sql-style", content: "old line\nnew line" })
		const review = await store.reviewDiffs((await store.readPendingReview(SKILL_DRAFTS_ID, "t1"))!)
		expect(review.changes[0].op).toBe("update")
		expect(review.changes[0].diff?.filter((line) => line.kind === "add").map((line) => line.text)).toEqual(["new line"])
		await keep("skill-sql-style")
		const parsed = parseSkillMarkdown(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"))
		expect(parsed.body).toContain("new line")
		// Its on/off state is the user's; an edit doesn't flip it.
		expect(parsed.extra.disabled).toBe(true)
		expect(enabled).toEqual([])
	})

	it("refuses unsafe or misplaced files", async () => {
		expect(
			await execute({
				kind: "skill",
				name: "x",
				description: "d",
				content: "c",
				files: [{ path: "../evil.sh", content: "" }],
			}),
		).toMatchObject({ error: expect.stringMatching(/inside the skill folder/) })
		expect(
			await execute({ kind: "workflow", name: "x", content: "c", files: [{ path: "a.sh", content: "" }] }),
		).toMatchObject({
			error: expect.stringMatching(/single file/),
		})
		expect(await execute({ kind: "skill", name: "x", content: "c" })).toMatchObject({
			error: expect.stringMatching(/description/),
		})
	})
	it("stages a skill and workflow with the same name independently", async () => {
		await execute({ kind: "skill", name: "deploy", description: "Deploy", content: "skill body" })
		await execute({ kind: "workflow", name: "deploy", content: "workflow body" })
		const pending = (await store.readPending(SKILL_DRAFTS_ID, "t1"))!
		expect(pending.map((change) => [change.slug, change.skill?.kind, change.content])).toEqual([
			["skill-deploy", "skill", "skill body"],
			["workflow-deploy", "workflow", "workflow body"],
		])
		await keep("skill-deploy")
		await keep("workflow-deploy")
		expect(await fs.readFile(path.join(root, "workflows", "deploy.md"), "utf8")).toBe("workflow body\n")
	})

	it("detects changed main and extra files before writing and keeps the original staging base", async () => {
		const dir = path.join(root, "global-skills", "foo")
		await fs.mkdir(dir, { recursive: true })
		const main = path.join(dir, "SKILL.md")
		const extra = path.join(dir, "data.txt")
		await fs.writeFile(main, "---\nname: foo\ndescription: Foo\n---\nold")
		await fs.writeFile(extra, "old extra")
		await execute({
			kind: "skill",
			name: "foo",
			content: "new",
			files: [
				{ path: "data.txt", content: "new extra" },
				{ path: "new.txt", content: "new file" },
			],
		})
		await fs.writeFile(main, "---\nname: foo\ndescription: Changed metadata\n---\nold")
		await fs.writeFile(extra, "mine")
		await fs.writeFile(path.join(dir, "new.txt"), "also mine")
		await execute({
			kind: "skill",
			name: "foo",
			content: "newer",
			files: [
				{ path: "data.txt", content: "newer extra" },
				{ path: "new.txt", content: "newer file" },
			],
		})
		await expect(keep("skill-foo")).rejects.toThrow("changed on disk")
		expect(await fs.readFile(main, "utf8")).toContain("Changed metadata")
		expect(await fs.readFile(extra, "utf8")).toBe("mine")
		expect(await fs.readFile(path.join(dir, "new.txt"), "utf8")).toBe("also mine")
		const pending = (await store.readPendingReview(SKILL_DRAFTS_ID, "t1"))!
		expect(Object.keys(pending.changes[0].skill!.conflict!)).toEqual(["SKILL.md", "data.txt", "new.txt"])
		await store.acceptSkillConflict(SKILL_DRAFTS_ID, "t1", pending.revision, "skill-foo")
		await fs.writeFile(extra, "mine again")
		await expect(keep("skill-foo")).rejects.toThrow("changed on disk")
		const latest = (await store.readPendingReview(SKILL_DRAFTS_ID, "t1"))!
		await store.acceptSkillConflict(SKILL_DRAFTS_ID, "t1", latest.revision, "skill-foo")
		await keep("skill-foo")
		expect(await fs.readFile(extra, "utf8")).toBe("newer extra")
	})

	it("refuses Keep through a linked extra folder before writing the main file", async () => {
		const dir = path.join(root, "global-skills", "foo")
		await fs.mkdir(dir, { recursive: true })
		const main = path.join(dir, "SKILL.md")
		await fs.writeFile(main, "---\nname: foo\ndescription: Foo\n---\nold")
		await execute({ kind: "skill", name: "foo", content: "new", files: [{ path: "scripts/keep.md", content: "new" }] })
		const outside = path.join(root, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "keep.md"), "mine")
		await fs.symlink(outside, path.join(dir, "scripts"))
		await expect(keep("skill-foo")).rejects.toThrow("linked")
		expect(await fs.readFile(main, "utf8")).toContain("old")
		expect(await fs.readFile(path.join(outside, "keep.md"), "utf8")).toBe("mine")
	})

	it("detects deleted workflows instead of recreating them without a choice", async () => {
		await fs.mkdir(path.join(root, "workflows"))
		const file = path.join(root, "workflows", "foo.md")
		await fs.writeFile(file, "old")
		await execute({ kind: "workflow", name: "foo", content: "new" })
		await fs.rm(file)
		await expect(keep("workflow-foo")).rejects.toThrow("changed on disk")
		await expect(fs.access(file)).rejects.toThrow()
	})
})
