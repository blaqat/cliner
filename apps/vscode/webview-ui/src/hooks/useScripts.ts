import { EmptyRequest } from "@shared/proto/cline/common"
import type { RefreshedScripts, ScriptInfo } from "@shared/proto/cline/file"
import { SCRIPT_APPROVALS, type ScriptApproval, type ScriptOption, type ScriptOptionKind } from "@shared/scripts"
import { useEffect, useSyncExternalStore } from "react"
import { FileServiceClient } from "@/services/grpc-client"

export interface ScriptEntry {
	name: string
	description: string
	path: string
	scope: "global" | "workspace"
	trusted?: boolean
	fingerprint?: string
	command?: string
	cwd?: string
	enabled: boolean
	/** Empty for invalid scripts. */
	approval: ScriptApproval | ""
	options: ScriptOption[]
	errors: string[]
}

export interface ScriptsSnapshot {
	global: ScriptEntry[]
	workspace: ScriptEntry[]
}

function toEntry(info: ScriptInfo, scope: ScriptEntry["scope"]): ScriptEntry {
	return {
		name: info.name,
		description: info.description,
		path: info.path,
		scope,
		enabled: info.enabled,
		trusted: info.trusted,
		fingerprint: info.fingerprint,
		command: info.command,
		cwd: info.cwd,
		approval: SCRIPT_APPROVALS.includes(info.approval as ScriptApproval) ? (info.approval as ScriptApproval) : "",
		errors: info.errors,
		options: info.options.map((option) => ({
			name: option.name,
			kind: option.kind as ScriptOptionKind,
			required: option.required,
			description: option.description,
			...(option.allowDash ? { allowDash: true } : {}),
			...(option.kind === "choice" ? { choices: option.choices } : {}),
			...(option.choicesFrom === "mmrc" ? { choicesFrom: "mmrc" as const } : {}),
			...(option.hasDefault
				? { default: option.kind === "flag" ? option.defaultValue === "true" : option.defaultValue }
				: {}),
		})),
	}
}

let snapshot: ScriptsSnapshot = { global: [], workspace: [] }
const listeners = new Set<() => void>()

/** Publishes a scripts response (list or mutation result) to every open composer and panel. */
export function applyScriptsResponse(response: RefreshedScripts): void {
	snapshot = {
		global: (response.globalScripts ?? []).map((info) => toEntry(info, "global")),
		workspace: (response.workspaceScripts ?? []).map((info) => toEntry(info, "workspace")),
	}
	for (const listener of listeners) listener()
}

/** Re-reads the script folders. Failures keep the last list (the composer must work without scripts). */
export async function refreshScripts(): Promise<void> {
	try {
		applyScriptsResponse(await FileServiceClient.refreshScripts(EmptyRequest.create({})))
	} catch {
		// Keep the previous snapshot.
	}
}

/** Enabled, valid scripts: what the agent sees and what `/` offers. */
export function usableScripts(scripts: ScriptsSnapshot): ScriptEntry[] {
	return [...scripts.workspace, ...scripts.global]
		.filter((script) => script.enabled && script.errors.length === 0 && script.approval !== "")
		.filter((script, index, all) => all.findIndex((other) => other.name === script.name) === index)
}

export function useScripts(options: { pollMs?: number } = {}): ScriptsSnapshot {
	const current = useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		() => snapshot,
	)
	const { pollMs } = options
	useEffect(() => {
		void refreshScripts()
		if (!pollMs) return
		// Files are edited in the editor, so a panel that is open follows the disk.
		const timer = setInterval(() => void refreshScripts(), pollMs)
		return () => clearInterval(timer)
	}, [pollMs])
	return current
}

/** Test helper: resets the shared snapshot. */
export function resetScriptsForTest(next: ScriptsSnapshot = { global: [], workspace: [] }): void {
	snapshot = next
	for (const listener of listeners) listener()
}
