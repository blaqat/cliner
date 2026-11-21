import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import {
	type ChangeWalkthrough,
	type WalkthroughAskConfig,
	type WalkthroughAskRequest,
	type WalkthroughAskThread,
	type WalkthroughRequest,
	walkthroughAskPick,
} from "@shared/Walkthrough"
import type { Controller } from "@/core/controller"
import { ensureTaskDirectoryExists } from "@/core/storage/disk"
import { HostProvider } from "@/hosts/host-provider"
import { backgroundHandler, useModelSettings } from "@/sdk/model-settings/background"
import { resolveEffectiveConfiguredPick } from "@/sdk/model-settings/host-settings"
import { resolveBackgroundPick } from "@/sdk/model-settings-resolver"
import { answerWalkthrough, askSelection, buildAskMessages } from "./ask"
import { readAuthoredWalkthrough } from "./authored"
import { collect, gitRoots, revertChange } from "./collection"
import { type ContentChange, cacheKey, formatNotes, generate, hash } from "./engine"

const services = new WeakMap<Controller, WalkthroughService>()
export function walkthroughService(controller: Controller): WalkthroughService {
	let service = services.get(controller)
	if (!service) {
		service = new WalkthroughService(controller)
		services.set(controller, service)
	}
	return service
}

export class WalkthroughService {
	private readonly documents = new Map<string, ChangeWalkthrough>()
	private generating = false
	private asking = false
	constructor(private readonly controller: Controller) {}

	private validate(request: WalkthroughRequest) {
		if (!request.taskId || this.controller.task?.taskId !== request.taskId) throw new Error("Open the requested thread first")
		if (!["thread", "last_turn", "git", "authored"].includes(request.scope)) throw new Error("Unknown walkthrough scope")
	}

	private async current(request: WalkthroughRequest) {
		this.validate(request)
		if (request.scope === "authored") throw new Error("Authored walkthroughs cannot collect local changes or Generate")
		return collect(await this.controller.getWalkthroughCollectionInput(request.taskId, request.scope))
	}

	private key(request: WalkthroughRequest) {
		return `${request.taskId}:${request.scope}`
	}

	async get(request: WalkthroughRequest): Promise<ChangeWalkthrough> {
		this.validate(request)
		if (request.scope === "authored")
			return this.withAsks(request, await readAuthoredWalkthrough(request.taskId, request.authoredId))
		const { walk } = await this.current(request)
		const previous = this.documents.get(this.key(request))
		const result =
			previous?.fingerprint === walk.fingerprint ? { ...previous, hunks: walk.hunks, warnings: walk.warnings } : walk
		this.documents.set(this.key(request), result)
		return this.withAsks(request, result)
	}

	async generate(
		request: WalkthroughRequest,
		oneCall?: import("@shared/model-settings").ModelPick,
	): Promise<ChangeWalkthrough> {
		if (this.generating) throw new Error("A walkthrough is already generating")
		this.generating = true
		try {
			const { walk, turns } = await this.current(request)
			if (!walk.hunks.length) return this.get(request)
			if (!useModelSettings(this.controller.stateManager)) {
				throw new Error("Generate needs your setup moved to the new Settings. Open Settings to see why it hasn't.")
			}
			const handler = await backgroundHandler(this.controller.stateManager, "generate", oneCall)
			if (!handler) throw new Error("Choose a Background text model in Settings > Models")
			const settings = this.controller.stateManager.getGlobalStateKey("modelSettings")!
			const generationPick = resolveBackgroundPick(settings, "generate", oneCall) ?? undefined
			const identity = { settings, oneCall }
			const cache = cacheKey(walk, identity, turns, request.reviewNotes)
			const directory = path.join(await ensureTaskDirectoryExists(request.taskId), "walkthrough-cache")
			const cacheFile = path.join(directory, `${cache}.json`)
			if (!request.regenerate) {
				try {
					const cached = JSON.parse(await readFile(cacheFile, "utf8")) as ChangeWalkthrough
					if (
						cached.version === 1 &&
						cached.fingerprint === walk.fingerprint &&
						Array.isArray(cached.chapters) &&
						Array.isArray(cached.support)
					) {
						const result = { ...cached, generationPick: cached.generationPick ?? generationPick, cacheHit: true }
						this.documents.set(this.key(request), result)
						return this.withAsks(request, result)
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
				}
			}
			const previous = this.documents.get(this.key(request))
			const result = {
				...(await generate(walk, turns, handler, request.regenerate ? previous : undefined, request.reviewNotes)),
				generationPick,
				cacheHit: false,
			}
			const latest = await this.current(request)
			if (latest.walk.fingerprint !== walk.fingerprint)
				throw new Error("Changes moved while generating. Refresh and Generate again.")
			await mkdir(directory, { recursive: true })
			await writeFile(cacheFile, JSON.stringify(result), "utf8")
			this.documents.set(this.key(request), result)
			return this.withAsks(request, result)
		} finally {
			this.generating = false
		}
	}

	private async askFile(request: WalkthroughRequest, fingerprint: string) {
		return path.join(
			await ensureTaskDirectoryExists(request.taskId),
			`walkthrough-asks-${hash([request.scope, request.authoredId, fingerprint])}.json`,
		)
	}

	private async readAsks(request: WalkthroughRequest, fingerprint: string): Promise<WalkthroughAskThread[]> {
		try {
			const saved = JSON.parse(await readFile(await this.askFile(request, fingerprint), "utf8"))
			if (!Array.isArray(saved)) throw new Error("Saved walkthrough answers could not be read.")
			return saved
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
			throw error
		}
	}

	private async askConfig(request: WalkthroughRequest, walk: ChangeWalkthrough): Promise<WalkthroughAskConfig> {
		const settings = this.controller.stateManager.getGlobalStateKey("modelSettings")
		const context = settings?.roles.walkthroughAsk?.context ?? "thread"
		if (!settings || !useModelSettings(this.controller.stateManager))
			return {
				pick: null,
				context,
				label: "No Ask model",
				unavailable: "Ask needs model setup. Open Settings > Models to finish it.",
			}
		const pick = walkthroughAskPick(
			settings.roles,
			walk.generationPick,
			await this.controller.getWalkthroughAskModel(request.taskId),
		)
		try {
			const resolved = resolveEffectiveConfiguredPick(this.controller.stateManager, settings, pick)
			const level = resolved.values.levels.find((level) => level.id === pick!.levelId)!
			return { pick, context, label: `${resolved.model.name || resolved.model.upstreamId} · ${level.label}` }
		} catch (error) {
			return { pick, context, label: "Ask model unavailable", unavailable: (error as Error).message }
		}
	}

	private async withAsks(request: WalkthroughRequest, walk: ChangeWalkthrough): Promise<ChangeWalkthrough> {
		return {
			...walk,
			askConfig: await this.askConfig(request, walk),
			askThreads: await this.readAsks(request, walk.fingerprint),
		}
	}

	async ask(request: WalkthroughAskRequest): Promise<WalkthroughAskThread> {
		this.validate(request)
		if (this.asking) throw new Error("Another walkthrough question is being answered. Wait for it, then ask again.")
		const question = typeof request.question === "string" ? request.question.trim() : ""
		if (request.quote !== undefined && typeof request.quote !== "string")
			throw new Error("Select text in the walkthrough before asking.")
		if (!question || question.length > 8000) throw new Error("Enter a question of up to 8,000 characters.")
		this.asking = true
		try {
			const { walk } = await this.reviewed(request)
			const saved = await this.readAsks(request, walk.fingerprint)
			const previous = request.askId ? saved.find((item) => item.id === request.askId) : undefined
			if (request.askId && !previous) throw new Error("This answer is no longer available. Select the lines and ask again.")
			const hunk = walk.hunks.find((hunk) => hunk.id === (previous?.hunkId ?? request.hunkId))
			if (!hunk) throw new Error("These lines are no longer in the walkthrough. Refresh and select them again.")
			const selection = askSelection(
				hunk,
				previous ? { ...request, line: previous.line, endLine: previous.endLine } : request,
			)
			const config = await this.askConfig(request, walk)
			if (config.unavailable || !config.pick)
				throw new Error(config.unavailable ?? "Choose an Ask model in Settings > Models.")
			const handler = await backgroundHandler(this.controller.stateManager, "generate", config.pick)
			if (!handler) throw new Error("Choose an Ask model in Settings > Models.")
			const context = await this.controller.getWalkthroughAskContext(request.taskId)
			const answer = await answerWalkthrough(
				handler,
				buildAskMessages(context.messages, config.context, selection.text, question, previous),
				config.context === "selection" ? undefined : context.prefix,
			)
			const result: WalkthroughAskThread = {
				id: previous?.id ?? randomUUID(),
				hunkId: hunk.id,
				line: selection.start,
				endLine: selection.end,
				quote: previous?.quote ?? request.quote?.slice(0, 2000),
				turns: [...(previous?.turns ?? []), { question, answer, pick: config.pick, context: config.context }],
			}
			const file = await this.askFile(request, walk.fingerprint)
			const temporary = `${file}.${randomUUID()}.tmp`
			await writeFile(temporary, JSON.stringify([...saved.filter((item) => item.id !== result.id), result]), "utf8")
			await rename(temporary, file)
			return result
		} finally {
			this.asking = false
		}
	}

	private async reviewed(request: WalkthroughRequest): Promise<{ walk: ChangeWalkthrough; changes: ContentChange[] }> {
		if (request.scope === "authored") {
			const walk = await this.get(request)
			if (request.fingerprint !== walk.fingerprint) throw new Error("Changes moved. Refresh the walkthrough first.")
			return { walk, changes: [] }
		}
		const current = await this.current(request)
		const walk = this.documents.get(this.key(request))
		if (!walk || request.fingerprint !== walk.fingerprint || current.walk.fingerprint !== walk.fingerprint)
			throw new Error("Changes moved. Refresh the walkthrough first.")
		return { walk, changes: current.changes }
	}

	async openDiff(request: WalkthroughRequest): Promise<void> {
		if (request.scope === "authored") throw new Error("Authored walkthroughs have no local diff to open")
		const { walk, changes } = await this.reviewed(request)
		const change = this.findChange(request, walk, changes)
		await HostProvider.diff.openMultiFileDiff({
			title: change.path,
			diffs: [{ filePath: change.filePath, leftContent: change.before, rightContent: change.after }],
		})
	}

	private findChange(request: WalkthroughRequest, walk: ChangeWalkthrough, changes: ContentChange[]): ContentChange {
		const fileId = request.hunkId ? walk.hunks.find((h) => h.id === request.hunkId)?.fileId : request.fileId
		const change = changes.find((c) => hash([c.filePath, c.turnId]).slice(0, 24) === fileId)
		if (!change) throw new Error("Unknown walkthrough file")
		return change
	}

	async revert(request: WalkthroughRequest): Promise<ChangeWalkthrough> {
		if (request.scope === "authored") throw new Error("Authored walkthroughs cannot revert local files")
		if (request.confirmed !== true) throw new Error("Confirm this revert inline first")
		const { walk, changes } = await this.reviewed(request)
		const input = await this.controller.getWalkthroughCollectionInput(request.taskId, request.scope)
		await revertChange(
			this.findChange(request, walk, changes),
			walk,
			request.hunkId,
			await gitRoots(input.roots, input.includeMmWorkspace),
		)
		this.documents.delete(this.key(request))
		return this.get(request)
	}

	async sendNotes(request: WalkthroughRequest): Promise<void> {
		const { walk } = await this.reviewed(request)
		const message = formatNotes(walk, {
			stopNotes: request.stopNotes ?? {},
			lineNotes: Array.isArray(request.lineNotes) ? request.lineNotes : [],
			overallNote: request.overallNote,
			reviewResponses: request.reviewResponses,
		})
		this.validate(request)
		await this.controller.task!.handleWebviewAskResponse("messageResponse", message, [], [])
	}
}
