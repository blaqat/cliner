import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { resolveClineDir } from "@cline/shared/storage"
import { type AutomationDefinition, validateAutomation } from "@shared/automations"
import { assertSafePath } from "../skills/skill-files"
import { type AutomationScope, formatIssues, parseAutomationFile, serializeAutomation } from "./automation-file"

/** Workspace automations sit next to the workspace workflows and scripts (`.clinerules/…`). */
export const WORKSPACE_AUTOMATIONS_DIR = path.join(".clinerules", "automations")

const STALE_PROPOSAL = "This automation changed in another window. Propose again from disk."

/** Global automations: `~/.cline/automations/` (redirected by `CLINE_DIR`, so tests never touch the real one). */
export function globalAutomationsDir(): string {
	return path.join(resolveClineDir(), "automations")
}

export interface LoadedAutomation {
	filePath: string
	scope: AutomationScope
	name: string
	description: string
	/** The file as it is on disk: what "View file" shows. */
	content: string
	/** Validation errors; an invalid file is listed but can't run. */
	errors: string[]
	definition?: AutomationDefinition
	/** The file is the version the user saved or last trusted. */
	trusted: boolean
	fingerprint: string
}

/** Path is part of identity: a workspace file never inherits a global file's trust. */
export function automationFingerprint(filePath: string, content: string): string {
	return createHash("sha256")
		.update(JSON.stringify([filePath, content]))
		.digest("hex")
}

/**
 * Remembers which version of each file the user saved or trusted, in extension storage (never in the
 * file). A repo automation someone else changed can start threads and spend money, so it needs a look first.
 */
class AutomationTrustStore {
	private memory: Record<string, string> = {}
	private writing: Promise<void> = Promise.resolve()
	constructor(private readonly getFile?: () => string) {}
	private async read(): Promise<Record<string, string>> {
		if (!this.getFile) return this.memory
		try {
			return JSON.parse(await fs.readFile(this.getFile(), "utf8"))
		} catch {
			return {}
		}
	}
	async get(filePath: string): Promise<string | undefined> {
		await this.writing
		return (await this.read())[filePath]
	}
	async set(filePath: string, fingerprint: string | undefined): Promise<void> {
		const write = this.writing.then(async () => {
			const next = { ...(await this.read()) }
			if (fingerprint) next[filePath] = fingerprint
			else delete next[filePath]
			if (this.getFile) {
				const file = this.getFile()
				await fs.mkdir(path.dirname(file), { recursive: true })
				await fs.writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
				await fs.rename(`${file}.tmp`, file)
			} else this.memory = next
		})
		this.writing = write.catch(() => {})
		await write
	}
}

export interface AutomationStoreDeps {
	getWorkspaceRoot: () => string | undefined
	getGlobalDir?: () => string
	getTrustFile?: () => string
}

export class AutomationStore {
	private readonly trust: AutomationTrustStore
	private writing: Promise<unknown> = Promise.resolve()
	constructor(private readonly deps: AutomationStoreDeps) {
		this.trust = new AutomationTrustStore(deps.getTrustFile)
	}

	dirFor(scope: AutomationScope): string | undefined {
		if (scope === "global") return (this.deps.getGlobalDir ?? globalAutomationsDir)()
		const root = this.deps.getWorkspaceRoot()
		return root ? path.join(root, WORKSPACE_AUTOMATIONS_DIR) : undefined
	}

	private async readDir(scope: AutomationScope): Promise<LoadedAutomation[]> {
		const dir = this.dirFor(scope)
		if (!dir) return []
		let entries: string[]
		try {
			entries = await fs.readdir(dir)
		} catch {
			return []
		}
		const loaded: LoadedAutomation[] = []
		for (const entry of entries.filter((file) => file.toLowerCase().endsWith(".md")).sort()) {
			const filePath = path.join(dir, entry)
			let content: string
			try {
				content = await fs.readFile(filePath, "utf8")
			} catch {
				continue
			}
			const parsed = parseAutomationFile(content, entry.replace(/\.md$/i, ""))
			const fingerprint = automationFingerprint(filePath, content)
			loaded.push({
				filePath,
				scope,
				name: parsed.name,
				description: parsed.description,
				content,
				errors: parsed.errors,
				definition: parsed.definition,
				trusted: (await this.trust.get(filePath)) === fingerprint,
				fingerprint,
			})
		}
		return loaded
	}

	/** Every automation file, workspace first. */
	async list(): Promise<LoadedAutomation[]> {
		const [workspace, global] = await Promise.all([this.readDir("workspace"), this.readDir("global")])
		return [...workspace, ...global]
	}

	/** The runnable automation called `name`: a workspace one shadows a global one. */
	async find(name: string): Promise<LoadedAutomation | undefined> {
		return (await this.list()).find((item) => item.definition?.name === name)
	}

	async findByPath(filePath: string): Promise<LoadedAutomation | undefined> {
		return (await this.list()).find((item) => item.filePath === filePath)
	}

	/**
	 * Writes a definition as its readable file and trusts that version (the user made it). Saving under a new
	 * name moves the file: the old one is removed, so renaming never leaves a copy behind.
	 */
	async save(definition: AutomationDefinition, scope: AutomationScope, previousPath?: string): Promise<LoadedAutomation> {
		const issues = validateAutomation(definition)
		if (issues.length > 0) throw new Error(formatIssues(issues)[0])
		return this.write(definition.name, serializeAutomation(definition), scope, previousPath)
	}

	async saveProposal(previousPath: string, fingerprint: string, content: string): Promise<LoadedAutomation> {
		const current = await this.findByPath(previousPath)
		if (!current) throw new Error(STALE_PROPOSAL)
		await this.writablePath(current.scope, previousPath)
		if (current.fingerprint !== fingerprint) throw new Error(STALE_PROPOSAL)
		const parsed = parseAutomationFile(content, current.name)
		if (!parsed.definition) throw new Error(parsed.errors[0] ?? "The proposed file has problems.")
		return this.write(parsed.definition.name, content, current.scope, previousPath, fingerprint)
	}

	private write(name: string, content: string, scope: AutomationScope, previousPath?: string, fingerprint?: string) {
		const write = this.writing.then(() => this.writeFile(name, content, scope, previousPath, fingerprint))
		this.writing = write.catch(() => {})
		return write
	}

	private async writablePath(scope: AutomationScope, filePath: string): Promise<string> {
		const dir = this.dirFor(scope)
		if (!dir || path.resolve(path.dirname(filePath)) !== path.resolve(dir))
			throw new Error("Choose a file inside the automations folder and try again.")
		const root = scope === "workspace" ? this.deps.getWorkspaceRoot()! : path.dirname(dir)
		const relative = path.relative(root, filePath)
		// The workspace or global storage root can be a user-selected alias. Everything inside it must be regular.
		const realRoot = await fs.realpath(root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return root
			throw error
		})
		return assertSafePath(realRoot, relative)
	}

	private async writeFile(name: string, content: string, scope: AutomationScope, previousPath?: string, fingerprint?: string) {
		const dir = this.dirFor(scope)
		if (!dir) throw new Error("Open a folder to save automations in this workspace.")
		const filePath = path.join(dir, `${name}.md`)
		const checkedPath = await this.writablePath(scope, filePath)
		const entries = await this.list()
		const clash = entries.find(
			(item) =>
				item.scope === scope && (item.name === name || item.filePath === filePath) && item.filePath !== previousPath,
		)
		if (clash) throw new Error(`An automation called ${name} already exists here.`)
		const previous = entries.find((item) => item.filePath === previousPath)
		if (previousPath && !previous)
			throw new Error(fingerprint ? STALE_PROPOSAL : "This automation file is gone. Reopen it and try again.")
		if (previous) await this.writablePath(previous.scope, previous.filePath)
		await fs.mkdir(path.dirname(checkedPath), { recursive: true })
		const destination = await this.writablePath(scope, filePath)
		const temp = path.join(path.dirname(destination), `.${randomUUID()}.tmp`)
		await fs.writeFile(temp, content, { encoding: "utf8", flag: "wx" })
		try {
			if (fingerprint && previous) {
				const source = await this.writablePath(previous.scope, previous.filePath)
				const latest = await fs.readFile(source, "utf8").catch(() => undefined)
				if (latest === undefined || automationFingerprint(previous.filePath, latest) !== fingerprint)
					throw new Error(STALE_PROPOSAL)
			}
			if ((await this.writablePath(scope, filePath)) !== destination)
				throw new Error("The automations folder moved. Reopen it and try again.")
			// Rename replaces the directory entry without ever opening the save destination for writing.
			await fs.rename(temp, destination)
		} finally {
			await fs.rm(temp, { force: true })
		}
		await this.trust.set(filePath, automationFingerprint(filePath, content))
		if (previous && path.resolve(previous.filePath) !== path.resolve(filePath)) {
			const source = await this.writablePath(previous.scope, previous.filePath)
			await fs.rm(source, { force: true })
			await this.trust.set(previous.filePath, undefined)
		}
		const saved = await this.findByPath(filePath)
		if (!saved) throw new Error("The automation was saved but couldn't be read back.")
		return saved
	}

	/** Trusts the file as it is now, only if it is still the version the user looked at. */
	async trustVersion(filePath: string, fingerprint: string): Promise<void> {
		const current = await this.findByPath(filePath)
		if (!current) throw new Error("That automation no longer exists.")
		if (current.fingerprint !== fingerprint) throw new Error("The file changed since you looked at it. Review it again.")
		await this.trust.set(filePath, fingerprint)
	}

	async remove(filePath: string): Promise<void> {
		const known = (await this.list()).some((item) => path.resolve(item.filePath) === path.resolve(filePath))
		if (!known) throw new Error("Only automation files can be deleted here.")
		await fs.rm(filePath, { force: true })
		await this.trust.set(filePath, undefined)
	}
}
