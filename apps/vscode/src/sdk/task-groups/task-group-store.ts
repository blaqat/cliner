import { promises as fs } from "node:fs"
import path from "node:path"
import { createSessionId } from "@cline/shared"
import { resolveClineDataDir } from "@cline/shared/storage"
import type { TaskGroup, TaskGroupSummary, TaskTag } from "@shared/task-groups"
import { Logger } from "@/shared/services/Logger"

/**
 * Root of the task-group store: `~/.cline/data/task-groups/<groupId>/`.
 *
 * Task-group data deliberately lives outside `data/sessions` and `data/tasks`
 * (the SDK owns those, and other Cline installs share `~/.cline`).
 */
export function taskGroupsRootDir(): string {
	return path.join(resolveClineDataDir(), "task-groups")
}

/** Identifiers are single path components, never paths or traversal segments. */
export function validateTaskGroupIdentifier(value: string, label = "identifier"): void {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) {
		throw new Error(`Invalid ${label}: expected a safe, non-empty identifier`)
	}
}

function insideTaskGroupsRoot(rootDir: string, ...parts: string[]): string {
	const root = path.resolve(rootDir)
	const resolved = path.resolve(root, ...parts)
	const relative = path.relative(root, resolved)
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Task-group path escapes the task-groups root")
	}
	return resolved
}

/** Layout of a single group's directory under the task-groups root. */
export function taskGroupPaths(rootDir: string, groupId: string) {
	validateTaskGroupIdentifier(groupId, "groupId")
	const resolve = (...parts: string[]) => insideTaskGroupsRoot(rootDir, groupId, ...parts)
	return {
		dir: resolve(),
		groupFile: resolve("group.json"),
		notebookDir: resolve("notebook"),
		noteFile: (slug: string) => {
			validateTaskGroupIdentifier(slug, "slug")
			return resolve("notebook", `${slug}.md`)
		},
		pendingDir: resolve("pending"),
		pendingFile: (threadId: string) => {
			validateTaskGroupIdentifier(threadId, "threadId")
			return resolve("pending", `${threadId}.json`)
		},
		activityFile: resolve("activity.jsonl"),
	}
}

/**
 * Write a file atomically: serialize to a sibling temp file, then rename over
 * the target so readers never observe a partially written file.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
	await fs.writeFile(tmpPath, content, "utf8")
	await fs.rename(tmpPath, filePath)
}

function isTaskTag(value: unknown): value is TaskTag {
	if (typeof value !== "object" || value === null) return false
	const tag = value as Record<string, unknown>
	return (
		(tag.kind === "ticket" || tag.kind === "branch" || tag.kind === "label") &&
		typeof tag.value === "string" &&
		(tag.source === "user" || tag.source === "auto")
	)
}

function parseTaskGroup(raw: unknown): TaskGroup | undefined {
	if (typeof raw !== "object" || raw === null) return undefined
	const group = raw as Record<string, unknown>
	if (typeof group.id !== "string" || !group.id) return undefined
	if (typeof group.title !== "string") return undefined
	const tags = Array.isArray(group.tags) ? group.tags.filter(isTaskTag) : []
	return {
		id: group.id,
		title: group.title,
		tags,
		createdAt: typeof group.createdAt === "number" ? group.createdAt : 0,
		updatedAt: typeof group.updatedAt === "number" ? group.updatedAt : 0,
	}
}

/**
 * File-backed store for task groups. Owns `group.json` per group directory;
 * notes, staged changes and the activity log live in `NotebookStore`, which
 * shares the same directory layout.
 */
export class TaskGroupStore {
	constructor(private readonly rootDir: string = taskGroupsRootDir()) {}

	async listGroups(): Promise<TaskGroup[]> {
		let entries: string[]
		try {
			entries = await fs.readdir(this.rootDir)
		} catch {
			return []
		}
		const groups: TaskGroup[] = []
		for (const entry of entries) {
			try {
				validateTaskGroupIdentifier(entry, "groupId")
			} catch {
				continue
			}
			const group = await this.getGroup(entry)
			if (group) groups.push(group)
		}
		return groups.sort((a, b) => b.updatedAt - a.updatedAt)
	}

	async getGroup(id: string): Promise<TaskGroup | undefined> {
		validateTaskGroupIdentifier(id, "groupId")
		try {
			const raw = await fs.readFile(taskGroupPaths(this.rootDir, id).groupFile, "utf8")
			return parseTaskGroup(JSON.parse(raw))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Logger.warn(`[TaskGroupStore] Failed to read task group ${id}:`, error)
			}
			return undefined
		}
	}

	async createGroup(input: { title: string; tags?: TaskTag[] }): Promise<TaskGroup> {
		const now = Date.now()
		const group: TaskGroup = {
			id: createSessionId(),
			title: input.title.trim(),
			tags: input.tags ?? [],
			createdAt: now,
			updatedAt: now,
		}
		await fs.mkdir(taskGroupPaths(this.rootDir, group.id).dir, { recursive: true })
		await this.writeGroup(group)
		return group
	}

	async updateGroup(id: string, update: { title?: string; tags?: TaskTag[] }): Promise<TaskGroup | undefined> {
		const group = await this.getGroup(id)
		if (!group) return undefined
		const next: TaskGroup = {
			...group,
			title: update.title !== undefined ? update.title.trim() : group.title,
			tags: update.tags ?? group.tags,
			updatedAt: Date.now(),
		}
		await this.writeGroup(next)
		return next
	}

	async deleteGroup(id: string): Promise<boolean> {
		const dir = taskGroupPaths(this.rootDir, id).dir
		try {
			await fs.rm(dir, { recursive: true, force: true })
			return true
		} catch (error) {
			Logger.warn(`[TaskGroupStore] Failed to delete task group ${id}:`, error)
			return false
		}
	}

	/** noteCount for TaskGroupSummary: number of notes in the group's notebook. */
	async noteCount(id: string): Promise<number> {
		validateTaskGroupIdentifier(id, "groupId")
		try {
			const entries = await fs.readdir(taskGroupPaths(this.rootDir, id).notebookDir)
			return entries.filter((entry) => entry.endsWith(".md")).length
		} catch {
			return 0
		}
	}

	async listGroupSummaries(): Promise<TaskGroupSummary[]> {
		const groups = await this.listGroups()
		return Promise.all(groups.map(async (group) => ({ ...group, noteCount: await this.noteCount(group.id) })))
	}

	private async writeGroup(group: TaskGroup): Promise<void> {
		await writeFileAtomic(taskGroupPaths(this.rootDir, group.id).groupFile, `${JSON.stringify(group, null, 2)}\n`)
	}
}
