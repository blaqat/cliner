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
		const applied = await store.applyPendingChanges(SKILL_DRAFTS_ID, "t1", "", [{ slug, include: true }], {
			apply: (change, edited) =>
				applySkillDraft(change, edited, places, async (_kind, file) => {
					enabled.push(file)
				}),
		})
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
		expect(change).toMatchObject({ op: "create", slug: "release-checklist", skill: { kind: "skill", scope: "global" } })

		await keep("release-checklist")
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
		await store.updatePendingSkill(SKILL_DRAFTS_ID, "t1", "deploy", { kind: "workflow", scope: "workspace", name: "ship-it" })
		await keep("deploy")
		const file = path.join(root, "workspace", ".clinerules", "workflows", "ship-it.md")
		expect(await fs.readFile(file, "utf8")).toBe("Steps\n")
		expect(enabled).toEqual([file])
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
		await keep("sql-style")
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
})
