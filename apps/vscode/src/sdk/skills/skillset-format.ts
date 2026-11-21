import { looksRunnable, SKILLSET_HOW_TO, type SkillItemKind, type SkillsetManifest, slugifySkillName } from "@shared/skillsets"
import { fallbackDescription, isPrivateFile, parseSkillMarkdown } from "./skill-files"
import type { ZipEntry } from "./zip"

/** One skill or workflow found in a skillset zip, before it's installed. */
export interface ParsedSkillsetItem {
	kind: SkillItemKind
	name: string
	description: string
	/** Skill: files relative to its folder (SKILL.md first). Workflow: one file, `<name>.md`. */
	files: { path: string; data: Buffer; mode: number }[]
	runsCode: boolean
}

export interface ParsedSkillset {
	name: string
	description?: string
	items: ParsedSkillsetItem[]
}

/** Noise some zip tools add, never part of a set. */
function isNoise(entryPath: string): boolean {
	return entryPath.startsWith("__MACOSX/") || entryPath.split("/").some((segment) => segment === ".DS_Store")
}

/** Removes one folder every entry sits in ("review-kit/skills/…" → "skills/…"). */
function stripCommonFolder(entries: ZipEntry[]): ZipEntry[] {
	const first = entries[0]?.path.split("/")[0]
	if (!first || entries.some((entry) => !entry.path.startsWith(`${first}/`))) return entries
	if (["skills", "workflows"].includes(first)) return entries
	// A single skill zipped as its folder keeps the folder: it names the skill.
	if (entries.some((entry) => entry.path === `${first}/SKILL.md`)) return entries
	return entries.map((entry) => ({ ...entry, path: entry.path.slice(first.length + 1) }))
}

function skillFromFiles(
	folderName: string,
	files: { path: string; data: Buffer; mode: number }[],
): ParsedSkillsetItem | undefined {
	const skillMd = files.find((file) => file.path === "SKILL.md")
	if (!skillMd) return undefined
	const parsed = parseSkillMarkdown(skillMd.data.toString("utf8"))
	const name = slugifySkillName(parsed.name || folderName)
	if (!name) return undefined
	const kept = files.filter((file) => !isPrivateFile(file.path))
	kept.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)))
	return {
		kind: "skill",
		name,
		description: parsed.description || fallbackDescription(parsed.body, name),
		files: kept,
		runsCode: kept.some((file) => file.path !== "SKILL.md" && looksRunnable(file.path, file.mode)),
	}
}

/**
 * What a zip holds: `skills/<name>/SKILL.md` folders and `workflows/*.md`
 * (the skillset layout), or a single skill zipped on its own (SKILL.md at the
 * root, or one folder holding it), the shape other agents share skills in.
 */
export function parseSkillset(entries: ZipEntry[], fileName: string): ParsedSkillset {
	const usable = stripCommonFolder(entries.filter((entry) => !isNoise(entry.path)))
	let manifest: Partial<SkillsetManifest> | undefined
	const manifestEntry = usable.find((entry) => entry.path === "skillset.json")
	if (manifestEntry) {
		try {
			manifest = JSON.parse(manifestEntry.data.toString("utf8"))
		} catch {
			manifest = undefined
		}
	}
	const baseName = fileName.replace(/\.skillset\.zip$/i, "").replace(/\.zip$/i, "")
	const items: ParsedSkillsetItem[] = []

	const skillFolders = new Map<string, { path: string; data: Buffer; mode: number }[]>()
	const addTo = (folder: string, file: { path: string; data: Buffer; mode: number }) => {
		const list = skillFolders.get(folder) ?? []
		list.push(file)
		skillFolders.set(folder, list)
	}
	const rootSkill = usable.some((entry) => entry.path === "SKILL.md")
	for (const entry of usable) {
		const parts = entry.path.split("/")
		if (parts[0] === "skills" && parts.length >= 3) {
			addTo(parts[1], { path: parts.slice(2).join("/"), data: entry.data, mode: entry.mode })
		} else if (parts[0] === "workflows" && parts.length === 2 && /\.md$/i.test(parts[1])) {
			const name = slugifySkillName(parts[1].replace(/\.md$/i, ""))
			if (!name || isPrivateFile(parts[1])) continue
			const text = entry.data.toString("utf8")
			items.push({
				kind: "workflow",
				name,
				description: fallbackDescription(parseSkillMarkdown(text).body, name),
				files: [{ path: `${name}.md`, data: entry.data, mode: entry.mode }],
				runsCode: false,
			})
		} else if (rootSkill && parts[0] !== "skills" && parts[0] !== "workflows") {
			if (entry.path === "skillset.json" || entry.path === "README.txt") continue
			addTo(`\0${baseName}`, { path: entry.path, data: entry.data, mode: entry.mode })
		} else if (!rootSkill && parts.length >= 2 && parts[0] !== "skills" && parts[0] !== "workflows") {
			addTo(parts[0], { path: parts.slice(1).join("/"), data: entry.data, mode: entry.mode })
		}
	}
	for (const [folder, files] of skillFolders) {
		const skill = skillFromFiles(folder.replace(/^\0/, ""), files)
		if (skill) items.push(skill)
	}
	// Skills first, each kind by name; a name listed twice keeps the first.
	const seen = new Set<string>()
	const unique = items
		.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "skill" ? -1 : 1))
		.filter((item) => {
			const key = `${item.kind}:${item.name}`
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
	return {
		name: (typeof manifest?.name === "string" && manifest.name.trim()) || baseName || "skillset",
		description: typeof manifest?.description === "string" ? manifest.description.slice(0, 300) : undefined,
		items: unique,
	}
}

/** The README.txt inside every saved set: what it is and how to add it. */
export function skillsetReadme(manifest: SkillsetManifest): string {
	const skills = manifest.items.filter((item) => item.kind === "skill")
	const workflows = manifest.items.filter((item) => item.kind === "workflow")
	const lines = [
		`${manifest.name}: a Cline skillset`,
		"",
		...(manifest.description ? [manifest.description, ""] : []),
		SKILLSET_HOW_TO,
		"",
		"New skills and workflows arrive switched off. Turn them on in Rules & workflows › Skills once you've looked inside.",
		"",
		...(skills.length
			? ["Skills:", ...skills.map((item) => `  - ${item.name}${item.description ? `: ${item.description}` : ""}`), ""]
			: []),
		...(workflows.length ? ["Workflows:", ...workflows.map((item) => `  - /${item.name}`), ""] : []),
	]
	return `${lines.join("\n").trimEnd()}\n`
}
