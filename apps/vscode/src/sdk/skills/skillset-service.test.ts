import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseSkillMarkdown } from "./skill-files"
import {
	buildSkillsetZip,
	importSkillset,
	listSkillsetLibrary,
	type SkillsetEnvironment,
	skillsetFileName,
	updateSkillsetItems,
} from "./skillset-service"
import { readZip, writeZip } from "./zip"

/** A profile in a temp folder: global skills and workflows, a workspace, toggles in memory. */
async function tempProfile(root: string) {
	const home = path.join(root, "home")
	const workspace = path.join(root, "workspace")
	const globalSkills = path.join(home, ".agents", "skills")
	const clineSkills = path.join(home, ".cline", "skills")
	const globalWorkflows = path.join(home, "Documents", "Cline", "Workflows")
	await fs.mkdir(globalSkills, { recursive: true })
	await fs.mkdir(globalWorkflows, { recursive: true })
	await fs.mkdir(workspace, { recursive: true })
	const toggles: Record<string, boolean> = {}
	const scanDirs = [
		{ path: path.join(workspace, ".clinerules", "skills"), isGlobal: false },
		{ path: path.join(workspace, ".cline", "skills"), isGlobal: false },
		{ path: path.join(workspace, ".claude", "skills"), isGlobal: false },
		{ path: path.join(workspace, ".agents", "skills"), isGlobal: false },
		{ path: clineSkills, isGlobal: true },
		{ path: globalSkills, isGlobal: true },
	]
	const env: SkillsetEnvironment = {
		globalSkillsDir: async () => globalSkills,
		globalWorkflowsDir: async () => globalWorkflows,
		skillScanDirs: () => scanDirs,
		workspaceWorkflowsDir: () => path.join(workspace, ".clinerules", "workflows"),
		registryPath: path.join(home, ".cline", "data", "skillsets.json"),
		listSkills: async () => {
			const skills = []
			for (const dir of scanDirs) {
				for (const name of await fs.readdir(dir.path).catch(() => [] as string[])) {
					const file = path.join(dir.path, name, "SKILL.md")
					const text = await fs.readFile(file, "utf8").catch(() => undefined)
					if (!text) continue
					const parsed = parseSkillMarkdown(text)
					skills.push({
						name,
						description: parsed.description ?? "",
						path: file,
						isGlobal: dir.isGlobal,
						enabled: toggles[file] ?? parsed.extra.disabled !== true,
					})
				}
			}
			return skills
		},
		listWorkflows: async () =>
			(await fs.readdir(globalWorkflows)).map((file) => {
				const full = path.join(globalWorkflows, file)
				return { path: full, isGlobal: true, enabled: toggles[full] ?? true }
			}),
		setSkillEnabled: async (file, _isGlobal, enabled) => {
			toggles[file] = enabled
		},
		setWorkflowEnabled: async (file, _isGlobal, enabled) => {
			toggles[file] = enabled
		},
		forgetToggle: async (_kind, file) => {
			delete toggles[file]
		},
	}
	const addSkill = async (dir: string, name: string, body: string, extra: Record<string, string> = {}) => {
		await fs.mkdir(path.join(dir, name), { recursive: true })
		await fs.writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} things\n---\n\n${body}\n`)
		for (const [file, content] of Object.entries(extra)) {
			await fs.mkdir(path.dirname(path.join(dir, name, file)), { recursive: true })
			await fs.writeFile(path.join(dir, name, file), content)
		}
	}
	return { env, toggles, globalSkills, clineSkills, globalWorkflows, workspace, addSkill }
}

describe("skillsets", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-skillsets-"))
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("saves a set and adds it to a fresh profile, switched off, with Remove all", async () => {
		const sender = await tempProfile(path.join(root, "sender"))
		await sender.addSkill(sender.globalSkills, "code-review", "# Review\nCheck the diff.", {
			"scripts/check.sh": "#!/bin/sh\necho ok\n",
			".env": "SECRET=1",
			"references/tips.md": "tips",
		})
		await fs.chmod(path.join(sender.globalSkills, "code-review", "scripts", "check.sh"), 0o755)
		await fs.writeFile(path.join(sender.globalWorkflows, "review-pr.md"), "# Review a PR\n1. Read it\n")
		const built = await buildSkillsetZip(
			[
				{ kind: "skill", path: path.join(sender.globalSkills, "code-review", "SKILL.md") },
				{ kind: "workflow", path: path.join(sender.globalWorkflows, "review-pr.md") },
			],
			{ name: "Review kit", description: "PR helpers" },
		)
		const inside = readZip(built.zip).map((entry) => entry.path)
		expect(inside).toEqual(
			expect.arrayContaining([
				"skillset.json",
				"README.txt",
				"skills/code-review/SKILL.md",
				"skills/code-review/scripts/check.sh",
				"skills/code-review/references/tips.md",
				"workflows/review-pr.md",
			]),
		)
		expect(inside).not.toContain("skills/code-review/.env")
		expect(built.skipped).toEqual(["code-review/.env"])
		expect(built.runsCode).toBe(1)
		const readme = readZip(built.zip)
			.find((entry) => entry.path === "README.txt")
			?.data.toString()
		expect(readme).toContain("hold Shift and drop")
		expect(skillsetFileName("Review kit")).toBe("review-kit.skillset.zip")

		const receiver = await tempProfile(path.join(root, "receiver"))
		const result = await importSkillset(receiver.env, built.zip, "review-kit.skillset.zip")
		expect(result).toMatchObject({ skills: 1, workflows: 1, alreadyHad: 0 })
		const skillMd = path.join(receiver.globalSkills, "code-review", "SKILL.md")
		const text = await fs.readFile(skillMd, "utf8")
		expect(parseSkillMarkdown(text).extra.disabled).toBe(true)
		expect(receiver.toggles[skillMd]).toBe(false)
		expect(receiver.toggles[path.join(receiver.globalWorkflows, "review-pr.md")]).toBe(false)
		expect((await fs.stat(path.join(receiver.globalSkills, "code-review", "scripts", "check.sh"))).mode & 0o111).toBeTruthy()
		expect(result.set?.name).toBe("Review kit")
		expect(result.set?.items.find((item) => item.kind === "skill")?.runsCode).toBe(true)

		const library = await listSkillsetLibrary(receiver.env, { includeFiles: true })
		expect(library.sets[0].items.every((item) => item.isNew)).toBe(true)
		expect(library.skills.find((skill) => skill.name === "code-review")?.files.map((file) => file.path)).toEqual([
			"SKILL.md",
			"references/tips.md",
			"scripts/check.sh",
		])

		await updateSkillsetItems(receiver.env, { setId: result.set!.id, action: "turn_on", paths: [skillMd] })
		expect(receiver.toggles[skillMd]).toBe(true)
		await updateSkillsetItems(receiver.env, { setId: result.set!.id, action: "remove" })
		await expect(fs.access(skillMd)).rejects.toThrow()
		await expect(fs.access(path.join(receiver.globalWorkflows, "review-pr.md"))).rejects.toThrow()
		expect((await listSkillsetLibrary(receiver.env)).sets).toEqual([])
	})

	it("keeps both on a name clash in any skill folder, and skips identical copies", async () => {
		const profile = await tempProfile(root)
		// The user already has code-review in the workspace's .claude/skills and sql in ~/.cline/skills.
		await profile.addSkill(path.join(profile.workspace, ".claude", "skills"), "code-review", "mine")
		await profile.addSkill(profile.clineSkills, "sql", "same body")
		const zip = writeZip([
			{
				path: "skills/code-review/SKILL.md",
				data: Buffer.from("---\nname: code-review\ndescription: theirs\n---\n\ntheirs\n"),
			},
			{ path: "skills/sql/SKILL.md", data: Buffer.from("---\nname: sql\ndescription: sql things\n---\n\nsame body\n") },
		])
		const result = await importSkillset(profile.env, zip, "kit.skillset.zip")
		expect(result).toMatchObject({ skills: 1, alreadyHad: 1 })
		// Adding the same set again finds the kept-both copy and adds nothing.
		expect(await importSkillset(profile.env, zip, "kit.skillset.zip")).toMatchObject({ skills: 0, alreadyHad: 2 })
		const added = result.set!.items[0]
		expect(added).toMatchObject({ name: "code-review-2", clashWith: "code-review" })
		// The loader needs the front matter name to match the folder.
		expect(parseSkillMarkdown(await fs.readFile(added.path, "utf8")).name).toBe("code-review-2")
	})

	it("accepts a single skill zipped on its own, and explains a zip with none", async () => {
		const profile = await tempProfile(root)
		const single = writeZip([
			{ path: "deploy/SKILL.md", data: Buffer.from("---\nname: deploy\ndescription: Ship it\n---\nSteps") },
			{ path: "__MACOSX/deploy/._SKILL.md", data: Buffer.from("junk") },
		])
		expect(await importSkillset(profile.env, single, "deploy.zip")).toMatchObject({ skills: 1 })
		const none = writeZip([{ path: "notes/todo.txt", data: Buffer.from("x") }])
		expect((await importSkillset(profile.env, none, "notes.zip")).error).toMatch(/No skills or workflows/)
		expect((await importSkillset(profile.env, Buffer.from("nope"), "x.zip")).error).toMatch(/zip/)
	})
})
