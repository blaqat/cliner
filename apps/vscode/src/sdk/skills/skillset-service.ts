import {
	type InstalledSkillset,
	SKILLSET_SUFFIX,
	type SkillItemKind,
	type SkillsetExportResult,
	type SkillsetImportResult,
	type SkillsetItem,
	type SkillsetLibrary,
	type SkillsetManifest,
	slugifySkillName,
} from "@shared/skillsets"
import { randomUUID } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import { buildSkillMarkdown, exists, listSkillFiles, MAX_SHARED_FILE_BYTES, parseSkillMarkdown, writeInside } from "./skill-files"
import { type ParsedSkillsetItem, parseSkillset, skillsetReadme } from "./skillset-format"
import { readZip, writeZip, ZipError } from "./zip"

/** Where skills and workflows live, and how their on/off state is kept. Injected so tests use temp folders. */
export interface SkillsetEnvironment {
	/** Where new global skills go (~/.agents/skills, like New skill…). */
	globalSkillsDir(): Promise<string>
	/** Where global workflows live (~/Documents/Cline/Workflows). */
	globalWorkflowsDir(): Promise<string>
	/** All six skill folders (four in the workspace, two global), for name clashes. */
	skillScanDirs(): { path: string; isGlobal: boolean }[]
	/** The workspace's workflow folder, when a workspace is open. */
	workspaceWorkflowsDir(): string | undefined
	/** The registry of sets that were added. */
	registryPath: string
	/** Every skill Cline sees, with its on/off state. */
	listSkills(): Promise<{ name: string; description: string; path: string; isGlobal: boolean; enabled: boolean }[]>
	/** Every workflow with its on/off state. */
	listWorkflows(): Promise<{ path: string; isGlobal: boolean; enabled: boolean }[]>
	setSkillEnabled(skillMdPath: string, isGlobal: boolean, enabled: boolean): Promise<void>
	setWorkflowEnabled(workflowPath: string, isGlobal: boolean, enabled: boolean): Promise<void>
	/** Drops a removed item's toggle entry. */
	forgetToggle(kind: SkillItemKind, itemPath: string, isGlobal: boolean): Promise<void>
	appVersion?: string
}

interface Registry {
	sets: InstalledSkillset[]
}

async function readRegistry(env: SkillsetEnvironment): Promise<Registry> {
	try {
		const raw = JSON.parse(await fs.readFile(env.registryPath, "utf8"))
		return { sets: Array.isArray(raw?.sets) ? raw.sets : [] }
	} catch {
		return { sets: [] }
	}
}

async function writeRegistry(env: SkillsetEnvironment, registry: Registry): Promise<void> {
	await fs.mkdir(path.dirname(env.registryPath), { recursive: true })
	const temp = `${env.registryPath}.${process.pid}.${Date.now()}.tmp`
	await fs.writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`)
	await fs.rename(temp, env.registryPath)
}

/** Every item's files as one comparable string: identical copies are skipped, not duplicated. */
async function sameSkillFolder(dir: string, item: ParsedSkillsetItem): Promise<boolean> {
	const { files } = await listSkillFiles(dir)
	if (files.length !== item.files.length) return false
	for (const file of item.files) {
		let existing: string
		try {
			existing = await fs.readFile(path.join(dir, file.path), "utf8")
		} catch {
			return false
		}
		const incoming = file.data.toString("utf8")
		if (file.path === "SKILL.md") {
			const a = parseSkillMarkdown(existing)
			const b = parseSkillMarkdown(incoming)
			if (a.body.trim() !== b.body.trim() || (a.description ?? "") !== (b.description ?? item.description)) return false
		} else if (existing !== incoming) {
			return false
		}
	}
	return true
}

/** True when `name` or one of its kept-both copies (`name-2`, `name-3`…) is identical: adding a set twice adds nothing. */
async function hasCopy(
	name: string,
	holders: (name: string) => Promise<string | undefined>,
	same: (holder: string) => Promise<boolean>,
): Promise<boolean> {
	for (let n = 1; n < 50; n++) {
		const holder = await holders(n === 1 ? name : `${name}-${n}`)
		if (!holder) return false
		if (holder !== "batch" && (await same(holder))) return true
	}
	return false
}

function nextFreeName(base: string, taken: (name: string) => Promise<boolean>): Promise<string> {
	const attempt = async (n: number): Promise<string> => {
		const candidate = `${base}-${n}`
		return (await taken(candidate)) ? attempt(n + 1) : candidate
	}
	return attempt(2)
}

/**
 * Adds a skillset zip: every skill and workflow lands globally and switched
 * off. A name the user already has (in any of the six skill folders) is kept
 * as `name-2` unless it's an identical copy, which is skipped and counted.
 */
export async function importSkillset(env: SkillsetEnvironment, buffer: Buffer, fileName: string): Promise<SkillsetImportResult> {
	const empty = { fileName, skills: 0, workflows: 0, alreadyHad: 0 }
	let parsed: ReturnType<typeof parseSkillset>
	try {
		parsed = parseSkillset(readZip(buffer), fileName)
	} catch (error) {
		return { ...empty, error: error instanceof ZipError ? error.message : "Couldn't read this file as a zip." }
	}
	if (!parsed.items.length) {
		return {
			...empty,
			error: "No skills or workflows in it. A skillset has a SKILL.md in each skill folder, or workflows/*.md.",
		}
	}

	const skillsDir = await env.globalSkillsDir()
	const workflowsDir = await env.globalWorkflowsDir()
	const scanDirs = env.skillScanDirs()
	const workflowDirs = [workflowsDir, env.workspaceWorkflowsDir()].filter((dir): dir is string => !!dir)
	const setId = randomUUID()
	const added: SkillsetItem[] = []
	let alreadyHad = 0

	for (const item of parsed.items) {
		if (item.kind === "skill") {
			const holders = async (name: string) => {
				for (const dir of scanDirs)
					if (await exists(path.join(dir.path, name, "SKILL.md"))) return path.join(dir.path, name)
				return added.some((entry) => entry.kind === "skill" && entry.name === name) ? "batch" : undefined
			}
			const current = await holders(item.name)
			if (await hasCopy(item.name, holders, (holder) => sameSkillFolder(holder, item))) {
				alreadyHad++
				continue
			}
			const name = current ? await nextFreeName(item.name, async (candidate) => !!(await holders(candidate))) : item.name
			const dir = path.join(skillsDir, name)
			for (const file of item.files) {
				if (file.path === "SKILL.md") {
					const skill = parseSkillMarkdown(file.data.toString("utf8"))
					const text = buildSkillMarkdown(skill.body, {
						name,
						description: skill.description || item.description,
						disabled: true,
						extra: skill.extra,
					})
					await writeInside(dir, "SKILL.md", text)
				} else {
					await writeInside(dir, file.path, file.data, file.mode)
				}
			}
			const skillMd = path.join(dir, "SKILL.md")
			await env.setSkillEnabled(skillMd, true, false)
			const listed = await listSkillFiles(dir)
			added.push({
				kind: "skill",
				name,
				description: item.description,
				path: skillMd,
				isGlobal: true,
				enabled: false,
				files: listed.files,
				runsCode: item.runsCode,
				isNew: true,
				setId,
				...(current ? { clashWith: item.name } : {}),
			})
		} else {
			const holders = async (name: string) => {
				for (const dir of workflowDirs)
					if (await exists(path.join(dir, `${name}.md`))) return path.join(dir, `${name}.md`)
				return added.some((entry) => entry.kind === "workflow" && entry.name === name) ? "batch" : undefined
			}
			const current = await holders(item.name)
			const incoming = item.files[0].data.toString("utf8")
			if (
				await hasCopy(
					item.name,
					holders,
					async (holder) => (await fs.readFile(holder, "utf8").catch(() => "")) === incoming,
				)
			) {
				alreadyHad++
				continue
			}
			const name = current ? await nextFreeName(item.name, async (candidate) => !!(await holders(candidate))) : item.name
			const target = await writeInside(workflowsDir, `${name}.md`, incoming)
			await env.setWorkflowEnabled(target, true, false)
			added.push({
				kind: "workflow",
				name,
				description: item.description,
				path: target,
				isGlobal: true,
				enabled: false,
				files: [{ path: `${name}.md`, size: Buffer.byteLength(incoming) }],
				runsCode: false,
				isNew: true,
				setId,
				...(current ? { clashWith: item.name } : {}),
			})
		}
	}

	const skills = added.filter((item) => item.kind === "skill").length
	const workflows = added.length - skills
	if (!added.length) return { ...empty, alreadyHad }
	const set: InstalledSkillset = {
		id: setId,
		name: parsed.name,
		...(parsed.description ? { description: parsed.description } : {}),
		fileName,
		addedAt: Date.now(),
		items: added,
	}
	const registry = await readRegistry(env)
	registry.sets.push(set)
	await writeRegistry(env, registry)
	return { set, fileName, skills, workflows, alreadyHad }
}

function workflowName(filePath: string): string {
	return path.basename(filePath).replace(/\.(md|txt)$/i, "")
}

/**
 * Every skill and workflow with its files, plus the sets that were added
 * (their items' on/off and New state read fresh from disk).
 */
export async function listSkillsetLibrary(
	env: SkillsetEnvironment,
	options: { includeFiles?: boolean } = {},
): Promise<SkillsetLibrary> {
	const registry = await readRegistry(env)
	const fromSet = new Map<string, SkillsetItem>()
	for (const set of registry.sets) for (const item of set.items) fromSet.set(path.resolve(item.path), item)

	const skills: SkillsetItem[] = []
	for (const skill of await env.listSkills()) {
		const files = options.includeFiles ? await listSkillFiles(path.dirname(skill.path)) : { files: [], skipped: [] }
		const recorded = fromSet.get(path.resolve(skill.path))
		skills.push({
			kind: "skill",
			name: skill.name,
			description: skill.description,
			path: skill.path,
			isGlobal: skill.isGlobal,
			enabled: skill.enabled,
			files: files.files,
			runsCode: files.files.some((file) => file.runsCode),
			...(files.skipped.length ? { skippedFiles: files.skipped } : {}),
			...(recorded
				? { setId: recorded.setId, isNew: !!recorded.isNew && !skill.enabled, clashWith: recorded.clashWith }
				: {}),
		})
	}
	const workflows: SkillsetItem[] = []
	for (const workflow of await env.listWorkflows()) {
		const stat = options.includeFiles ? await fs.stat(workflow.path).catch(() => undefined) : undefined
		const text = options.includeFiles ? await fs.readFile(workflow.path, "utf8").catch(() => "") : ""
		const name = workflowName(workflow.path)
		const recorded = fromSet.get(path.resolve(workflow.path))
		workflows.push({
			kind: "workflow",
			name,
			description: text
				? (parseSkillMarkdown(text)
						.body.split("\n")
						.map((line) => line.replace(/^#+\s*/, "").trim())
						.find(Boolean) ?? "")
				: "",
			path: workflow.path,
			isGlobal: workflow.isGlobal,
			enabled: workflow.enabled,
			files: stat ? [{ path: path.basename(workflow.path), size: stat.size }] : [],
			runsCode: false,
			...(recorded
				? { setId: recorded.setId, isNew: !!recorded.isNew && !workflow.enabled, clashWith: recorded.clashWith }
				: {}),
		})
	}
	// A set's items as they are now: removed ones drop out; a set with none left is forgotten.
	const present = new Map([...skills, ...workflows].map((item) => [path.resolve(item.path), item]))
	const sets = registry.sets
		.map((set) => ({
			...set,
			items: set.items.flatMap((item) => {
				const live = present.get(path.resolve(item.path))
				return live ? [{ ...item, ...live, files: live.files.length ? live.files : item.files }] : []
			}),
		}))
		.filter((set) => set.items.length)
	if (sets.length !== registry.sets.length) {
		await writeRegistry(env, { sets: registry.sets.filter((set) => sets.some((entry) => entry.id === set.id)) })
	}
	skills.sort((a, b) => a.name.localeCompare(b.name))
	workflows.sort((a, b) => a.name.localeCompare(b.name))
	return { skills, workflows, sets, hasWorkspace: env.skillScanDirs().some((dir) => !dir.isGlobal) }
}

/** Turn on, remove, or mark seen: items of a set (all when `paths` is empty). */
export async function updateSkillsetItems(
	env: SkillsetEnvironment,
	input: { setId: string; action: "turn_on" | "remove" | "seen"; paths?: string[] },
): Promise<void> {
	const registry = await readRegistry(env)
	const set = registry.sets.find((entry) => entry.id === input.setId)
	if (!set) throw new Error("That skillset is no longer recorded.")
	const chosen = set.items.filter((item) => !input.paths?.length || input.paths.includes(item.path))
	for (const item of chosen) {
		if (input.action === "turn_on") {
			if (item.kind === "skill") await env.setSkillEnabled(item.path, item.isGlobal, true)
			else await env.setWorkflowEnabled(item.path, item.isGlobal, true)
			item.enabled = true
			item.isNew = false
		} else if (input.action === "seen") {
			item.isNew = false
		} else {
			// Only what the set added: a skill folder named like the set's item, or the workflow file.
			if (item.kind === "skill") await fs.rm(path.dirname(item.path), { recursive: true, force: true })
			else await fs.rm(item.path, { force: true })
			await env.forgetToggle(item.kind, item.path, item.isGlobal)
		}
	}
	if (input.action === "remove") set.items = set.items.filter((item) => !chosen.includes(item))
	registry.sets = registry.sets.filter((entry) => entry.items.length)
	await writeRegistry(env, registry)
}

/** The files of a set to save: manifest, README, skills/<name>/…, workflows/<name>.md. */
export async function buildSkillsetZip(
	items: { kind: SkillItemKind; path: string }[],
	meta: { name: string; description?: string; appVersion?: string },
): Promise<{ zip: Buffer; layout: string[]; skipped: string[]; runsCode: number; count: number }> {
	const files: { path: string; data: Buffer; mode?: number }[] = []
	const skipped: string[] = []
	const manifestItems: SkillsetManifest["items"] = []
	const used = new Set<string>()
	const layout: string[] = []
	let runsCode = 0
	const unique = (kind: SkillItemKind, base: string) => {
		let name = base
		for (let n = 2; used.has(`${kind}:${name}`); n++) name = `${base}-${n}`
		used.add(`${kind}:${name}`)
		return name
	}
	for (const item of items) {
		if (item.kind === "skill") {
			const dir = path.dirname(item.path)
			const markdown = parseSkillMarkdown(await fs.readFile(item.path, "utf8"))
			const name = unique("skill", slugifySkillName(markdown.name || path.basename(dir)) || "skill")
			const listed = await listSkillFiles(dir)
			skipped.push(...listed.skipped.map((file) => `${name}/${file}`))
			let scripts = 0
			for (const file of listed.files) {
				const full = path.join(dir, file.path)
				if (file.path === "SKILL.md") {
					const text = buildSkillMarkdown(markdown.body, {
						name,
						description: markdown.description ?? "",
						extra: markdown.extra,
					})
					files.push({ path: `skills/${name}/SKILL.md`, data: Buffer.from(text) })
				} else {
					const stat = await fs.stat(full)
					files.push({ path: `skills/${name}/${file.path}`, data: await fs.readFile(full), mode: stat.mode })
					if (file.runsCode) scripts++
				}
			}
			if (scripts) runsCode++
			manifestItems.push({ kind: "skill", name, description: markdown.description })
			layout.push(
				`skills/${name}/… (${listed.files.length} file${listed.files.length === 1 ? "" : "s"}${scripts ? `, ${scripts} script${scripts === 1 ? "" : "s"}` : ""})`,
			)
		} else {
			const stat = await fs.stat(item.path)
			if (stat.size > MAX_SHARED_FILE_BYTES) {
				skipped.push(path.basename(item.path))
				continue
			}
			const name = unique("workflow", slugifySkillName(workflowName(item.path)) || "workflow")
			files.push({ path: `workflows/${name}.md`, data: await fs.readFile(item.path) })
			manifestItems.push({ kind: "workflow", name })
			layout.push(`workflows/${name}.md`)
		}
	}
	const manifest: SkillsetManifest = {
		format: 1,
		name: meta.name,
		...(meta.description ? { description: meta.description } : {}),
		createdWith: `Cline (Fork)${meta.appVersion ? ` ${meta.appVersion}` : ""}`,
		items: manifestItems,
	}
	files.unshift(
		{ path: "skillset.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
		{ path: "README.txt", data: Buffer.from(skillsetReadme(manifest)) },
	)
	return {
		zip: writeZip(files),
		layout: ["skillset.json · README.txt", ...layout],
		skipped,
		runsCode,
		count: manifestItems.length,
	}
}

/** Saves a set to `target` (a path from the save dialog). */
export async function exportSkillset(
	items: { kind: SkillItemKind; path: string }[],
	meta: { name: string; description?: string; appVersion?: string },
	target: string,
): Promise<SkillsetExportResult> {
	if (!items.length) throw new Error("Pick at least one skill or workflow.")
	const built = await buildSkillsetZip(items, meta)
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.writeFile(target, built.zip)
	return {
		path: target,
		fileName: path.basename(target),
		bytes: built.zip.length,
		items: built.count,
		runsCode: built.runsCode,
		skipped: built.skipped,
		layout: built.layout,
	}
}

/** `review-kit.skillset.zip` from a typed name. */
export function skillsetFileName(name: string): string {
	return `${slugifySkillName(name) || "skillset"}${SKILLSET_SUFFIX}`
}
