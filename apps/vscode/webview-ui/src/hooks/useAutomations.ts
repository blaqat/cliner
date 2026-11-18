import type { AutomationDefinition } from "@shared/automations"
import type { AutomationInfo, AutomationList } from "@shared/proto/cline/automation"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useEffect, useSyncExternalStore } from "react"
import { AutomationServiceClient } from "@/services/grpc-client"

export interface AutomationEntry {
	name: string
	description: string
	path: string
	scope: "global" | "workspace"
	errors: string[]
	trusted: boolean
	fingerprint: string
	/** Absent for an invalid file. */
	definition?: AutomationDefinition
	/** The file as it is on disk. */
	content: string
}

export interface AutomationsSnapshot {
	automations: AutomationEntry[]
	globalDir: string
	workspaceDir: string
	/** False until the first list arrives, so empty states don't flash. */
	loaded: boolean
}

function parseDefinition(json: string): AutomationDefinition | undefined {
	if (!json) return undefined
	try {
		return JSON.parse(json) as AutomationDefinition
	} catch {
		return undefined
	}
}

function toEntry(info: AutomationInfo): AutomationEntry {
	return {
		name: info.name,
		description: info.description,
		path: info.path,
		scope: info.scope === "global" ? "global" : "workspace",
		errors: info.errors,
		trusted: info.trusted,
		fingerprint: info.fingerprint,
		definition: parseDefinition(info.definitionJson),
		content: info.content,
	}
}

let snapshot: AutomationsSnapshot = { automations: [], globalDir: "", workspaceDir: "", loaded: false }
const listeners = new Set<() => void>()

/** Publishes a list (from a refresh or a mutation) to every composer, panel and builder. */
export function applyAutomationList(response: AutomationList): void {
	snapshot = {
		automations: (response.automations ?? []).map(toEntry),
		globalDir: response.globalDir,
		workspaceDir: response.workspaceDir,
		loaded: true,
	}
	for (const listener of listeners) listener()
}

/** Re-reads the automation folders. Failures keep the last list (the composer must work without them). */
export async function refreshAutomations(): Promise<void> {
	try {
		applyAutomationList(await AutomationServiceClient.listAutomations(EmptyRequest.create({})))
	} catch {
		// Keep the previous snapshot.
	}
}

/** Valid automations, a workspace one shadowing a global one of the same name: what `/` offers. */
export function runnableAutomations(
	automations: readonly AutomationEntry[],
): (AutomationEntry & { definition: AutomationDefinition })[] {
	return automations
		.filter((entry): entry is AutomationEntry & { definition: AutomationDefinition } => !!entry.definition)
		.filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index)
}

export function useAutomations(options: { pollMs?: number } = {}): AutomationsSnapshot {
	const current = useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		() => snapshot,
	)
	const { pollMs } = options
	useEffect(() => {
		void refreshAutomations()
		if (!pollMs) return
		// Files can change outside the builder (a pull, a teammate), so an open panel follows the disk.
		const timer = setInterval(() => void refreshAutomations(), pollMs)
		return () => clearInterval(timer)
	}, [pollMs])
	return current
}

/** Test helper: replaces the shared snapshot. */
export function resetAutomationsForTest(automations: AutomationEntry[] = []): void {
	snapshot = { automations, globalDir: "~/.cline/automations", workspaceDir: ".clinerules/automations", loaded: true }
	for (const listener of listeners) listener()
}
