import type { AgentToolContext } from "@cline/shared"
import { parseTypedOptions, splitScriptInvocation } from "@shared/scripts"
import type { ToolApprovalRequest } from "../sdk-interaction-coordinator"
import { decideScriptApproval, readScriptToolInput, type ScriptApprovalDecision, ScriptRunGrants } from "./script-approval"
import { resolveScriptRun } from "./script-command"
import type { ScriptDefinition } from "./script-file"
import { ScriptStore, type ScriptStoreDeps } from "./script-store"
import {
	buildScriptInvocationInstruction,
	createScriptTool,
	resolveScriptCwdIdentity,
	type ScriptCwd,
	type ScriptToolContext,
	verifyScriptCwd,
} from "./script-tool"
import { scriptFingerprint } from "./script-trust"

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
	private readonly approvals = new Map<
		string,
		{ script?: ScriptDefinition; input: unknown; approved: boolean; expires: number; cwd?: ScriptCwd }
	>()
	private approvalKey(context: Pick<AgentToolContext, "agentId" | "toolCallId" | "conversationId">): string {
		return `${context.conversationId}|${context.agentId}|${context.toolCallId}`
	}

	async prepareApproval(
		request: ToolApprovalRequest,
		mode: "plan" | "act",
		threadId: string,
		workspaceRoot = this.deps.getWorkspaceRoot() ?? process.cwd(),
	) {
		const input = readScriptToolInput(request.input)
		if (!input) return { decision: "reject" as const }
		if (input.action !== "run") return { decision: "allow" as const }
		const script = await this.store.find(input.name)
		for (const [key, entry] of this.approvals) if (entry.expires < Date.now()) this.approvals.delete(key)
		const decision = script
			? await decideScriptApproval({ store: this.store, grants: this.grants }, request.input, mode, threadId, script)
			: ("reject" as const)
		const cwd = script ? await resolveScriptCwdIdentity(script, workspaceRoot) : undefined
		this.approvals.set(this.approvalKey(request), {
			cwd,
			script,
			input: structuredClone(request.input),
			approved: decision === "allow",
			expires: Date.now() + 10 * 60 * 1000,
		})
		const unreviewed = script && !(await this.store.trust.isTrusted(script))
		return {
			decision,
			...(unreviewed
				? {
						review: {
							scriptCommand: script.command,
							scriptCwd: cwd!.path,
							scriptFingerprint: scriptFingerprint(script),
						},
					}
				: {}),
		}
	}

	async completeApproval(request: ToolApprovalRequest, approved: boolean, trust: boolean): Promise<void> {
		const key = this.approvalKey(request)
		const entry = this.approvals.get(key)
		if (!approved) {
			this.approvals.delete(key)
			return
		}
		if (!entry?.script) throw new Error("Script is no longer available. Request approval again.")
		const current = await this.store.find(entry.script.name)
		if (!current || scriptFingerprint(current) !== scriptFingerprint(entry.script))
			throw new Error("Script changed after approval was requested. Review the current version and run again.")
		if (trust) await this.store.trust.trust(entry.script)
		entry.approved = true
	}

	private async takeApprovedRun(input: unknown, context: AgentToolContext): Promise<{ script: ScriptDefinition; cwd: string }> {
		const key = this.approvalKey(context)
		const entry = this.approvals.get(key)
		this.approvals.delete(key)
		if (!entry?.approved || !entry.script || !entry.cwd || entry.expires < Date.now())
			throw new Error("No approval for this script version. Request approval again.")
		const request = readScriptToolInput(input)
		const original = readScriptToolInput(entry.input)
		const script = await this.store.find(entry.script.name)
		if (!script || scriptFingerprint(script) !== scriptFingerprint(entry.script))
			throw new Error("Script changed after approval. Review the current version and run again.")
		const run = resolveScriptRun(entry.script, request?.options)
		const expected = resolveScriptRun(entry.script, original?.options)
		if (request?.name !== entry.script.name || !run.ok || !expected.ok || run.command !== expected.command)
			throw new Error("Script options changed after approval. Request approval again.")
		return { script: entry.script, cwd: await verifyScriptCwd(entry.cwd) }
	}

	constructor(private readonly deps: ScriptsHostDeps) {
		this.store = new ScriptStore(deps)
	}

	/** Tool context for a session whose files live under `cwd`. */
	toolContext(cwd: string | undefined): ScriptToolContext {
		return {
			store: this.store,
			takeApprovedRun: (input, context) => this.takeApprovedRun(input, context),
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
		if (await this.store.trust.isTrusted(script))
			this.grants.grant(threadId, script.name, resolved.values, scriptFingerprint(script))
		return buildScriptInvocationInstruction(script, resolved.values, invocation.note)
	}
}
