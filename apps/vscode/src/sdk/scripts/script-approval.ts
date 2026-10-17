import type { ScriptApproval, ScriptValues } from "@shared/scripts"
import { resolveScriptRun } from "./script-command"
import type { ScriptDefinition } from "./script-file"
import type { ScriptStore } from "./script-store"
import { scriptFingerprint } from "./script-trust"

export type ScriptApprovalDecision = "allow" | "ask" | "reject"

/**
 * Approval levels, like read vs write tools:
 * - always_ask: asks in both modes;
 * - ask_in_ask_mode (default): asks in Ask mode, runs in Act mode;
 * - always_allow: runs in both modes, Ask included.
 */
export function scriptApprovalDecision(approval: ScriptApproval, mode: "plan" | "act"): ScriptApprovalDecision {
	if (approval === "always_allow") return "allow"
	if (approval === "always_ask") return "ask"
	return mode === "plan" ? "ask" : "allow"
}

function canonicalRun(name: string, values: ScriptValues): string {
	const sorted = Object.keys(values)
		.sort()
		.map((key) => [key, values[key]])
	return `${name}:${JSON.stringify(sorted)}`
}

const GRANT_TTL_MS = 10 * 60 * 1000

/**
 * One-shot approvals for runs the user asked for by typing the script into the
 * composer. A grant covers exactly one run of that script with those values in
 * that thread, so the agent cannot reuse it for different values or later runs.
 */
export class ScriptRunGrants {
	private readonly grants = new Map<string, { expiresAt: number; fingerprint: string }>()

	constructor(private readonly now: () => number = Date.now) {}

	grant(threadId: string, name: string, values: ScriptValues, fingerprint: string): void {
		this.grants.set(`${threadId}|${canonicalRun(name, values)}`, { expiresAt: this.now() + GRANT_TTL_MS, fingerprint })
	}

	consume(threadId: string, name: string, values: ScriptValues, fingerprint: string): boolean | "changed" {
		const key = `${threadId}|${canonicalRun(name, values)}`
		const entry = this.grants.get(key)
		if (entry === undefined) return false
		this.grants.delete(key)
		if (entry.expiresAt <= this.now()) return false
		return entry.fingerprint === fingerprint ? true : "changed"
	}
}

/** What the `script` tool is being asked to do, from its raw input. */
export function readScriptToolInput(
	input: unknown,
): { action: "load" | "run"; name: string; options?: Record<string, unknown> } | undefined {
	let parsed = input
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed)
		} catch {
			return undefined
		}
	}
	if (typeof parsed !== "object" || parsed === null) return undefined
	const record = parsed as Record<string, unknown>
	const action = record.action === "load" ? "load" : record.action === "run" ? "run" : undefined
	if (!action || typeof record.name !== "string") return undefined
	const options =
		typeof record.options === "object" && record.options !== null ? (record.options as Record<string, unknown>) : undefined
	return { action, name: record.name.trim().replace(/^\//, ""), options }
}

export interface ScriptApprovalContext {
	store: ScriptStore
	grants: ScriptRunGrants
}

/**
 * Whether a `script` tool call may run without asking. Loading notes never
 * asks; a call the tool will reject (unknown script, bad values) also passes,
 * since it cannot run anything.
 */
export async function decideScriptApproval(
	context: ScriptApprovalContext,
	input: unknown,
	mode: "plan" | "act",
	threadId: string,
	snapshot?: ScriptDefinition,
): Promise<ScriptApprovalDecision> {
	const request = readScriptToolInput(input)
	if (!request) return "reject"
	if (request.action === "load") return "allow"
	const script = snapshot ?? (await context.store.find(request.name))
	if (!script) return "reject"
	const resolved = resolveScriptRun(script, request.options)
	if (!resolved.ok) return "reject"
	const grant = context.grants.consume(threadId, script.name, resolved.values, scriptFingerprint(script))
	if (grant === "changed") return "reject"
	if (!(await context.store.trust.isTrusted(script))) return "ask"
	return grant ? "allow" : scriptApprovalDecision(script.approval, mode)
}
