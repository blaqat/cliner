import { promises as fs } from "node:fs"
import path from "node:path"
import type { AutomationProblem, AutomationRun } from "@shared/automations"
import { AutomationRunner, type AutomationRunnerDeps, type StoredAutomationRun } from "./automation-runner"
import { AutomationStore } from "./automation-store"

export interface AutomationsHostDeps extends Omit<AutomationRunnerDeps, "load" | "save" | "onChange"> {
	getWorkspaceRoot: () => string | undefined
	/** Extension storage: trust fingerprints and run history live here, never in the repo. */
	getStorageDir: () => string
	onRunsChanged: (runs: readonly AutomationRun[]) => void
}

/** The automation store and runner for one extension. */
export class AutomationsHost {
	readonly store: AutomationStore
	readonly runner: AutomationRunner

	constructor(deps: AutomationsHostDeps) {
		this.precheck = deps.precheck
		const runsFile = () => path.join(deps.getStorageDir(), "automation-runs.json")
		this.store = new AutomationStore({
			getWorkspaceRoot: deps.getWorkspaceRoot,
			getTrustFile: () => path.join(deps.getStorageDir(), "automation-trust.json"),
		})
		this.runner = new AutomationRunner({
			...deps,
			onChange: deps.onRunsChanged,
			load: async () => {
				const parsed = JSON.parse(await fs.readFile(runsFile(), "utf8"))
				return Array.isArray(parsed) ? (parsed as StoredAutomationRun[]) : []
			},
			save: (runs) => {
				// One write at a time, and only the newest runs: changes come in bursts while threads stream.
				this.pendingRuns = runs
				this.writing = this.writing.then(async () => {
					const next = this.pendingRuns
					this.pendingRuns = undefined
					if (!next) return
					const file = runsFile()
					await fs.mkdir(path.dirname(file), { recursive: true })
					await fs.writeFile(`${file}.tmp`, JSON.stringify(next))
					await fs.rename(`${file}.tmp`, file)
				})
				this.writing = this.writing.catch(() => {})
				return this.writing
			},
		})
	}

	private writing: Promise<void> = Promise.resolve()
	private pendingRuns: readonly StoredAutomationRun[] | undefined
	private readonly precheck: AutomationRunnerDeps["precheck"]

	/** Resolves once the newest runs are on disk. */
	flushed(): Promise<void> {
		return this.writing
	}

	/**
	 * Starts `/name` as the user typed it in the composer. Runs only the version the start form showed
	 * (`fingerprint`), and only once the user saved or trusted it.
	 */
	async start(
		name: string,
		values: Record<string, string>,
		options: { taskGroupId?: string; fingerprint: string },
	): Promise<AutomationRun> {
		const loaded = await this.store.find(name)
		if (!loaded?.definition) throw new Error(`There's no automation called ${name}.`)
		if (loaded.fingerprint !== options.fingerprint)
			throw new Error(`${name} changed since the start form opened. Check what will run, then run it again.`)
		if (!loaded.trusted) throw new Error(`${name} changed since you last trusted it. Review it in Automations first.`)
		return this.runner.start(loaded.definition, values, { taskGroupId: options.taskGroupId })
	}

	/**
	 * What must be fixed before `/name` can run (for the start form), so the user sees it before pressing
	 * Run. Empty when it can run, or when there's no such automation (the start form says that itself).
	 */
	async check(name: string): Promise<AutomationProblem[]> {
		const loaded = await this.store.find(name)
		if (!loaded?.definition) return []
		return (await this.precheck?.(loaded.definition.steps)) ?? []
	}

	/**
	 * Resumes a finished run (Retry, or from a step) or starts it again fresh, with the automation as it
	 * is now, so a fix to its file counts. Only a version the user saved or trusted runs.
	 */
	async resume(runId: string, options: { fromStepId?: string; fresh?: boolean }): Promise<AutomationRun> {
		await this.runner.load()
		const run = this.runner.list().find((candidate) => candidate.id === runId)
		if (!run) throw new Error("That run is gone. Start the automation again.")
		const loaded = await this.store.find(run.automation)
		if (!loaded) throw new Error(`There's no automation called ${run.automation} anymore, so this run can't go on.`)
		if (!loaded.definition) throw new Error(`${run.automation}'s file has problems. Fix it in Automations, then try again.`)
		if (!loaded.trusted)
			throw new Error(`${run.automation} changed since you last trusted it. Review it in Automations first.`)
		return options.fresh
			? this.runner.runAgain(runId, loaded.definition)
			: this.runner.resume(runId, loaded.definition, options.fromStepId)
	}
}
