import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ChangeWalkthrough, WalkthroughRequest } from "@shared/Walkthrough"
import type { Controller } from "@/core/controller"
import { apiConfigurationForModelProfile, resolveModelProfile } from "@/core/controller/models/modelProfiles"
import { ensureTaskDirectoryExists } from "@/core/storage/disk"
import { HostProvider } from "@/hosts/host-provider"
import { buildApiHandler, buildSdkProviderConfig } from "@/sdk/sdk-api-handler"
import { readAuthoredWalkthrough } from "./authored"
import { collect, gitRoots, revertChange } from "./collection"
import { type ContentChange, cacheKey, formatNotes, generate, hash, repairOutput } from "./engine"

/** The profile Generate used last (Settings › Profiles › Text generation › Walkthrough Generate). */
export function readRememberedWalkthroughProfileId(controller: Controller): string | undefined {
	return controller.stateManager.getGlobalStateKey("walkthroughGenerateModelProfileId") || undefined
}

/** Generate remembers whichever profile it ran with, so the ▾ starts there next time. */
function rememberWalkthroughProfileId(controller: Controller, profileId: string): void {
	if (readRememberedWalkthroughProfileId(controller) === profileId) return
	controller.stateManager.setGlobalState("walkthroughGenerateModelProfileId", profileId)
	void controller.postStateToWebview()
}

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
		if (request.scope === "authored") return readAuthoredWalkthrough(request.taskId, request.authoredId)
		const { walk } = await this.current(request)
		const previous = this.documents.get(this.key(request))
		const result =
			previous?.fingerprint === walk.fingerprint ? { ...previous, hunks: walk.hunks, warnings: walk.warnings } : walk
		this.documents.set(this.key(request), result)
		return result
	}

	async generate(request: WalkthroughRequest): Promise<ChangeWalkthrough> {
		if (this.generating) throw new Error("A walkthrough is already generating")
		this.generating = true
		try {
			const { walk, turns } = await this.current(request)
			if (!walk.hunks.length) return this.get(request)
			const profileId = request.profileId?.trim() || readRememberedWalkthroughProfileId(this.controller)
			const resolved = resolveModelProfile(this.controller.stateManager, profileId)
			if (!resolved) throw new Error("Choose a profile for Generate")
			const { profile, configuration } = resolved
			const config = apiConfigurationForModelProfile(this.controller.stateManager, profile.id, "act")
			// Explicit profiles remain explicit even for large diffs; this prevents silently changing their cost/provider.
			const provider = buildSdkProviderConfig(config, "act")
			const identity = {
				profile: profile.id,
				configuration: configuration.id,
				apiType: configuration.openAiCompatibleApiType,
				routingProvider: provider.routingProviderId,
				provider: provider.providerId,
				model: provider.modelId,
				options: configuration.options,
				effort: resolved.reasoningEffort,
				endpoint: provider.baseUrl,
			}
			const cache = cacheKey(walk, identity, turns)
			const directory = path.join(await ensureTaskDirectoryExists(request.taskId), "walkthrough-cache")
			const cacheFile = path.join(directory, `${cache}.json`)
			if (!request.regenerate) {
				try {
					const cached = JSON.parse(await readFile(cacheFile, "utf8")) as ChangeWalkthrough
					if (
						cached.fingerprint === walk.fingerprint &&
						cached.version === 1 &&
						Array.isArray(cached.chapters) &&
						Array.isArray(cached.support)
					) {
						const normalized = repairOutput(
							{
								...cached,
								support: cached.support.flatMap((stop) => (Array.isArray(stop?.hunkIds) ? stop.hunkIds : [])),
							},
							walk,
						)
						const result = { ...normalized, profileId: profile.id, cacheHit: true }
						this.documents.set(this.key(request), result)
						rememberWalkthroughProfileId(this.controller, profile.id)
						return result
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
				}
			}
			const previous = this.documents.get(this.key(request))
			const result = {
				...(await generate(walk, turns, buildApiHandler(config, "act"), request.regenerate ? previous : undefined)),
				profileId: profile.id,
				cacheHit: false,
			}
			const latest = await this.current(request)
			if (latest.walk.fingerprint !== walk.fingerprint)
				throw new Error("Changes moved while generating. Refresh and Generate again.")
			await mkdir(directory, { recursive: true })
			await writeFile(cacheFile, JSON.stringify(result), "utf8")
			this.documents.set(this.key(request), result)
			rememberWalkthroughProfileId(this.controller, profile.id)
			return result
		} finally {
			this.generating = false
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
		await revertChange(this.findChange(request, walk, changes), walk, request.hunkId, await gitRoots(input.roots))
		this.documents.delete(this.key(request))
		return this.get(request)
	}

	async sendNotes(request: WalkthroughRequest): Promise<void> {
		const { walk } = await this.reviewed(request)
		const message = formatNotes(walk, {
			stopNotes: request.stopNotes ?? {},
			lineNotes: Array.isArray(request.lineNotes) ? request.lineNotes : [],
			overallNote: request.overallNote,
		})
		this.validate(request)
		await this.controller.task!.handleWebviewAskResponse("messageResponse", message, [], [])
	}
}
