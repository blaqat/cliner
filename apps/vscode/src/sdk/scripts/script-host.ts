import { parseTypedOptions, splitScriptInvocation } from "@shared/scripts"
import { decideScriptApproval, type ScriptApprovalDecision, ScriptRunGrants } from "./script-approval"
import { resolveScriptRun } from "./script-command"
import { ScriptStore, type ScriptStoreDeps } from "./script-store"
import { buildScriptInvocationInstruction, createScriptTool, type ScriptToolContext } from "./script-tool"

export interface ScriptsHostDeps extends ScriptStoreDeps {
	/** Extension storage folder for full run logs. */
	getLogDir: () => string
	/** The terminal environment helper: the full env a command in `cwd` runs with. */
	resolveEnv: (cwd: string) => Promise<Record<string, string>>
}

/** Ties the script store, the tool, approvals and composer invocations together for one extension. */
export class ScriptsHost {
	readonly store: ScriptStore
	readonly grants = new ScriptRunGrants()

	constructor(private readonly deps: ScriptsHostDeps) {
		this.store = new ScriptStore(deps)
	}

	/** Tool context for a session whose files live under `cwd`. */
	toolContext(cwd: string | undefined): ScriptToolContext {
		return {
			store: this.store,
			getWorkspaceRoot: () => cwd ?? this.deps.getWorkspaceRoot() ?? process.cwd(),
			resolveEnv: this.deps.resolveEnv,
			logDir: this.deps.getLogDir(),
		}
	}

	createTool(cwd: string | undefined) {
		return createScriptTool(this.toolContext(cwd))
	}

	decideApproval(input: unknown, mode: "plan" | "act", threadId: string): Promise<ScriptApprovalDecision> {
		return decideScriptApproval({ store: this.store, grants: this.grants }, input, mode, threadId)
	}

	/**
	 * A message that starts with `/<script> options…` becomes an instruction to run that
	 * script with exactly those values, and the user's typing counts as approval for that
	 * one run. Returns undefined when the text isn't a valid script invocation, so it falls
	 * through to normal slash-command handling.
	 */
	async expandInvocation(text: string, threadId: string): Promise<string | undefined> {
		const invocation = splitScriptInvocation(text)
		if (!invocation) return undefined
		const script = await this.store.find(invocation.name)
		if (!script) return undefined
		const parsed = parseTypedOptions(invocation.optionsText, script.options, { final: true })
		if (parsed.issues.length > 0 || parsed.missing.length > 0) return undefined
		const resolved = resolveScriptRun(script, parsed.values)
		if (!resolved.ok) return undefined
		this.grants.grant(threadId, script.name, resolved.values)
		return buildScriptInvocationInstruction(script, resolved.values, invocation.note)
	}
}
